import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/persistence.js';

function snapshot(counter = 0, revision = 0, gameId = 'game-one') {
  return {
    version: 1, gameId, phase: 'closed', idCounter: counter, finishCounter: 0,
    players: [], questions: [{ question: 'Test', options: ['A', 'B', 'C', 'D'], correctIndex: 0 }],
    startedAt: null, endedAt: null, hideLeaderboardNumbers: false, revision,
  };
}

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'quiz-persistence-test-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, store: new JsonStore(dataDir) };
}

async function json(dataDir, name) {
  return JSON.parse(await readFile(path.join(dataDir, name), 'utf8'));
}

test('new storage starts empty and writes private atomic state and counter files', async (t) => {
  const { dataDir, store } = await fixture(t);
  assert.deepEqual(await store.init(), { saved: null, counter: 0 });
  await store.save(snapshot());
  await store.flush();
  assert.deepEqual(await json(dataDir, 'state.json'), snapshot());
  assert.deepEqual(await json(dataDir, 'id-counter.json'), { version: 1, counter: 0 });
  assert.deepEqual((await readdir(dataDir)).sort(), ['archives', 'id-counter.json', 'state.json']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(dataDir, 'archives'))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(dataDir, 'state.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(dataDir, 'id-counter.json'))).mode & 0o777, 0o600);
  }
});

test('concurrent saves coalesce into the latest snapshot and all promises await durability', async (t) => {
  const { dataDir, store } = await fixture(t);
  await store.init();
  const writes = [];
  const original = store._writeAtomic.bind(store);
  store._writeAtomic = async (filename, data) => {
    writes.push(path.basename(filename));
    await original(filename, data);
  };
  const promises = Array.from({ length: 150 }, (_, index) => {
    const revision = index + 1;
    return store.save(snapshot(revision, revision)).then(async () => {
      assert.ok((await json(dataDir, 'state.json')).revision >= revision);
    });
  });
  await Promise.all(promises);
  assert.deepEqual(writes, ['id-counter.json', 'state.json']);
  assert.equal((await json(dataDir, 'state.json')).revision, 150);
  assert.equal((await json(dataDir, 'id-counter.json')).counter, 150);
});

test('a save arriving during an active write waits for its own batch and writes never overlap', async (t) => {
  const { dataDir, store } = await fixture(t);
  await store.init();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const original = store._writeAtomic.bind(store);
  let active = 0;
  let maximumActive = 0;
  const writes = [];
  store._writeAtomic = async (filename, data) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    writes.push([path.basename(filename), data.counter ?? data.revision]);
    if (path.basename(filename) === 'state.json' && data.revision === 1) {
      entered();
      await gate;
    }
    await original(filename, data);
    active -= 1;
  };
  const first = store.save(snapshot(1, 1));
  const flushing = store.flush();
  await started;
  let laterResolved = false;
  const second = store.save(snapshot(2, 2)).then(() => { laterResolved = true; });
  const third = store.save(snapshot(3, 3));
  await Promise.resolve();
  assert.equal(laterResolved, false);
  release();
  await Promise.all([first, second, third, flushing]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(writes, [
    ['id-counter.json', 1], ['state.json', 1], ['id-counter.json', 3], ['state.json', 3],
  ]);
  assert.equal((await json(dataDir, 'state.json')).revision, 3);
});

test('snapshot data is copied before the caller can mutate it', async (t) => {
  const { dataDir, store } = await fixture(t);
  await store.init();
  const value = snapshot(12, 1);
  const saving = store.save(value);
  value.idCounter = 1;
  value.revision = 99;
  value.questions[0].question = 'Changed after save';
  await saving;
  const durable = await json(dataDir, 'state.json');
  assert.equal(durable.revision, 1);
  assert.equal(durable.idCounter, 12);
  assert.equal(durable.questions[0].question, 'Test');
});

test('ID high-water mark remains monotonic through lower snapshots, resets and restarts', async (t) => {
  const { dataDir, store } = await fixture(t);
  await store.init();
  await store.save(snapshot(42, 1));
  await store.save(snapshot(0, 2, 'reset-game'));
  assert.equal((await json(dataDir, 'state.json')).idCounter, 42);
  assert.equal((await json(dataDir, 'id-counter.json')).counter, 42);
  const reopened = new JsonStore(dataDir);
  const loaded = await reopened.init();
  assert.equal(loaded.saved.gameId, 'reset-game');
  assert.equal(loaded.counter, 42);
  await reopened.save(snapshot(43, 3, 'reset-game'));
  assert.equal((await json(dataDir, 'id-counter.json')).counter, 43);
});

test('counter reservation survives a failed state write and failure rejects every pending caller', async (t) => {
  const { dataDir, store } = await fixture(t);
  await store.init();
  const original = store._writeAtomic.bind(store);
  store._writeAtomic = async (filename, data) => {
    if (path.basename(filename) === 'state.json') throw new Error('Simulated disk full');
    await original(filename, data);
  };
  const results = await Promise.allSettled([
    store.save(snapshot(41, 1)), store.save(snapshot(42, 2)), store.save(snapshot(43, 3)),
  ]);
  assert.ok(results.every((result) => result.status === 'rejected' && /disk full/.test(result.reason.message)));
  assert.equal((await json(dataDir, 'id-counter.json')).counter, 43);
  await assert.rejects(store.flush(), /disk full/);
  await assert.rejects(store.save(snapshot(44, 4)), /disk full/);
  const reopened = new JsonStore(dataDir);
  assert.deepEqual(await reopened.init(), { saved: null, counter: 43 });
  await reopened.save(snapshot(0, 5));
  assert.equal((await json(dataDir, 'state.json')).idCounter, 43);
});

test('archives preserve full snapshots before reset and reserve their player IDs', async (t) => {
  const { dataDir, store } = await fixture(t);
  await store.init();
  const final = snapshot(50, 9);
  final.phase = 'finished';
  const filename = await store.archive(final);
  assert.equal(filename, path.join(dataDir, 'archives', 'game-one.json'));
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), final);
  await store.save(snapshot(0, 10, 'new-game'));
  assert.deepEqual(await json(dataDir, path.join('archives', 'game-one.json')), final);
  assert.equal((await json(dataDir, 'id-counter.json')).counter, 50);
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);
  await assert.rejects(store.archive({ ...final, gameId: '../escape' }), /Invalid game snapshot/);
});

test('corrupt JSON, malformed snapshots and invalid counters fail without deleting files', async (t) => {
  const cases = [
    ['state.json', '{broken'],
    ['state.json', 'null'],
    ['state.json', '{}'],
    ['state.json', JSON.stringify({ ...snapshot(), idCounter: -1 })],
    ['id-counter.json', '{broken'],
    ['id-counter.json', '0'],
    ['id-counter.json', '[]'],
    ['id-counter.json', JSON.stringify({ counter: -1 })],
    ['id-counter.json', JSON.stringify({ counter: 1.5 })],
    ['id-counter.json', JSON.stringify({ counter: Number.MAX_SAFE_INTEGER + 1 })],
  ];
  for (const [name, content] of cases) {
    const { dataDir, store } = await fixture(t);
    await writeFile(path.join(dataDir, name), content);
    await assert.rejects(store.init(), (error) => error.message.includes(name));
    assert.equal(await readFile(path.join(dataDir, name), 'utf8'), content);
  }
});

test('a saved snapshot recovers missing counter files and counters lower than recorded IDs', async (t) => {
  const { dataDir, store } = await fixture(t);
  const saved = snapshot(12, 1);
  saved.players.push({ id: 'P-050' });
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify(saved));
  const loaded = await store.init();
  assert.equal(loaded.counter, 50);
  await store.save(snapshot(1, 2));
  assert.equal((await json(dataDir, 'id-counter.json')).counter, 50);
});

test('storage must be initialized before writes or flushing', async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(store.save(snapshot()), /init/);
  await assert.rejects(store.flush(), /init/);
  await assert.rejects(store.archive(snapshot()), /init/);
});
