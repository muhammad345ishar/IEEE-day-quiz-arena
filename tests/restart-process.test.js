import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const credentials = { username: 'crash-test-admin', password: 'crash-test-password-only' };
const bank = [
  { question: 'First saved question', options: ['A', 'B', 'C', 'D'], correctIndex: 2 },
  { question: 'Second saved question', options: ['E', 'F', 'G', 'H'], correctIndex: 0 },
  { question: 'Third saved question', options: ['I', 'J', 'K', 'L'], correctIndex: 3 },
];

async function killImmediately(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arena-abrupt-restart-'));
  const helperPath = path.join(directory, 'run-arena.mjs');
  const questionsPath = path.join(directory, 'questions.json');
  const children = new Set();
  t.after(async () => {
    await Promise.all([...children].map(killImmediately));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(questionsPath, JSON.stringify(bank));
  await writeFile(path.join(directory, '.env'), `ADMIN_USER=${credentials.username}\nADMIN_PASS=${credentials.password}\nPORT=3000\n`, { mode: 0o600 });
  // The child intentionally has no shutdown hook. SIGKILL can never flush its memory.
  await writeFile(helperPath, `
    import { createArena } from ${JSON.stringify(new URL('../server/app.js', import.meta.url).href)};
    import { loadConfig } from ${JSON.stringify(new URL('../server/config.js', import.meta.url).href)};
    try {
      const config = loadConfig(process.env.IEEE_RESTART_TEST_ROOT, () => {});
      const arena = await createArena({ ...config, port: 0, lanHost: '127.0.0.1' });
      const address = await arena.listen(0, '127.0.0.1');
      process.send({ type: 'ready', url: address.url });
    } catch (error) {
      process.send({ type: 'failed', error: error.message });
      process.exitCode = 1;
    }
  `);
  async function start() {
    const child = fork(helperPath, [], {
      cwd: directory,
      execArgv: [],
      env: { ...process.env, IEEE_RESTART_TEST_ROOT: directory, DATA_DIR: 'data', PORT: '3000', LAN_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.once('exit', () => children.delete(child));
    let output = '';
    child.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(-4000); });
    child.stderr.on('data', (chunk) => { output = (output + chunk.toString()).slice(-4000); });
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Child arena did not start: ${output}`)), 15_000);
      const exited = (code, signal) => { clearTimeout(timeout); reject(new Error(`Child exited before starting (${code ?? signal}): ${output}`)); };
      child.once('exit', exited);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('message', (message) => {
        clearTimeout(timeout);
        child.off('exit', exited);
        if (message.type === 'ready') resolve(message.url);
        else reject(new Error(`Child startup failed: ${message.error}`));
      });
    });
    async function request(route, { cookie, body } = {}) {
      const response = await fetch(url + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    async function login() {
      const response = await request('/api/admin/login', { body: credentials });
      assert.equal(response.status, 200);
      return response.cookie;
    }
    async function control(cookie, action) {
      const response = await request('/api/admin/control', { cookie, body: { action } });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      return response.data;
    }
    async function join(name) {
      const response = await request('/api/player/join', { body: { name } });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      return { ...response.data, cookie: response.cookie };
    }
    return { child, request, login, control, join };
  }
  return { directory, questionsPath, start };
}

test('SIGKILL preserves acknowledged answers, finish time, player sessions and IDs without a graceful flush', { timeout: 30_000 }, async (t) => {
  const fixtureData = await fixture(t);
  let arena = await fixtureData.start();
  const adminBeforeCrash = await arena.login();
  await arena.control(adminBeforeCrash, 'open');
  const continuing = await arena.join('Duplicate name');
  const finisher = await arena.join('Duplicate name');
  const started = await arena.control(adminBeforeCrash, 'start');
  const answerBody = (questionIndex) => ({ gameId: started.state.gameId, questionIndex, optionIndex: bank[questionIndex].correctIndex });
  const fullBank = await arena.request('/api/player/me', { cookie: continuing.cookie });
  let finishedResult;
  for (let questionIndex = 0; questionIndex < bank.length; questionIndex += 1) {
    finishedResult = await arena.request('/api/player/answer', { cookie: finisher.cookie, body: answerBody(questionIndex) });
    assert.equal(finishedResult.status, 200);
  }
  const lockedAnswer = await arena.request('/api/player/answer', { cookie: continuing.cookie, body: answerBody(0) });
  assert.equal(lockedAnswer.status, 200);
  assert.equal(lockedAnswer.data.player.progress, 1);
  await killImmediately(arena.child);

  // A changed source file must wait for reset; occupied games retain their snapshot.
  const editedBank = [{ ...bank[0], question: 'The next event uses this edited question.' }];
  await writeFile(fixtureData.questionsPath, JSON.stringify(editedBank));
  await new Promise((resolve) => setTimeout(resolve, 180));
  arena = await fixtureData.start();
  const resumed = await arena.request('/api/player/me', { cookie: continuing.cookie });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.player.id, continuing.player.id);
  assert.equal(resumed.data.player.progress, 1);
  assert.equal(resumed.data.player.correct, null);
  assert.equal(resumed.data.state.gameId, started.state.gameId);
  assert.equal(resumed.data.state.startedAt, started.state.startedAt);
  assert.equal(resumed.data.state.questionFileChanged, true);
  assert.deepEqual(resumed.data.questions, fullBank.data.questions);
  assert.doesNotMatch(JSON.stringify(resumed.data.questions), /correctIndex/);
  assert.ok(resumed.data.serverNow >= lockedAnswer.data.serverNow + 150, 'Elapsed server time includes downtime.');
  const originalFinisher = await arena.request('/api/player/me', { cookie: finisher.cookie });
  assert.equal(originalFinisher.data.player.totalTimeMs, finishedResult.data.player.totalTimeMs);
  assert.equal(originalFinisher.data.player.correct, 3);
  assert.equal((await arena.request('/api/player/answer', { cookie: continuing.cookie, body: answerBody(0) })).status, 409);
  assert.equal((await arena.request('/api/admin/state', { cookie: adminBeforeCrash })).status, 401);
  for (const questionIndex of [1, 2]) {
    const response = await arena.request('/api/player/answer', { cookie: continuing.cookie, body: answerBody(questionIndex) });
    assert.equal(response.status, 200);
  }
  const completed = await arena.request('/api/player/me', { cookie: continuing.cookie });
  assert.equal(completed.data.player.correct, 3);
  assert.equal(completed.data.player.rank, 2);
  assert.ok(completed.data.player.totalTimeMs >= resumed.data.serverNow - started.state.startedAt);
  const durable = JSON.parse(await readFile(path.join(fixtureData.directory, 'data', 'state.json'), 'utf8'));
  const savedPlayer = durable.players.find((player) => player.id === continuing.player.id);
  assert.equal(savedPlayer.answers.length, 3);
  assert.equal(savedPlayer.finishedAt - durable.startedAt, completed.data.player.totalTimeMs);

  const adminAfterCrash = await arena.login();
  const reset = await arena.control(adminAfterCrash, 'reset');
  assert.equal(reset.state.totalQuestions, 1);
  await arena.control(adminAfterCrash, 'open');
  const third = await arena.join('Duplicate name');
  assert.equal(third.player.id, 'P-003');
  await killImmediately(arena.child);
  arena = await fixtureData.start();
  assert.equal((await arena.request('/api/player/me', { cookie: third.cookie })).data.player.id, 'P-003');
  const fourth = await arena.join('Duplicate name');
  assert.equal(fourth.player.id, 'P-004');
  assert.equal((await arena.request('/api/player/me', { cookie: continuing.cookie })).status, 401);
});
