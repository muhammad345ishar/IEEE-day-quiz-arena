import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connectSocket } from 'socket.io-client';
import { createArena } from '../server/app.js';

const bank = [
  { question: 'Choose C', options: ['A', 'B', 'C', 'D'], correctIndex: 2 },
  { question: 'Choose A', options: ['A', 'B', 'C', 'D'], correctIndex: 0 },
  { question: 'Choose D', options: ['A', 'B', 'C', 'D'], correctIndex: 3 },
];
const credentials = { username: 'event-admin', password: 'api-test-password-only' };

async function fixture(t, questions = bank) {
  const root = await mkdtemp(join(tmpdir(), 'quiz-arena-api-'));
  const dataDir = join(root, 'data');
  const questionsPath = join(root, 'questions.json');
  await mkdir(dataDir);
  await writeFile(questionsPath, JSON.stringify(questions, null, 2));
  let clock = 1_000_000;
  let arena;
  let url;
  const sockets = [];
  const options = { dataDir, questionsPath, credentials, lanHost: '127.0.0.1', port: 0, now: () => clock };
  const start = async () => {
    arena = await createArena(options);
    ({ url } = await arena.listen(0, '127.0.0.1'));
  };
  await start();
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await arena?.close();
    await rm(root, { recursive: true, force: true });
  });
  const request = async (path, { method = 'GET', cookie, body, headers = {} } = {}) => {
    const response = await fetch(url + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { response, status: response.status, data, text, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async () => {
    const response = await request('/api/admin/login', { method: 'POST', body: credentials });
    assert.equal(response.status, 200, response.text);
    assert.ok(response.cookie, 'Login establishes a session cookie.');
    return response.cookie;
  };
  const control = async (cookie, action, expectedStatus = 200) => {
    const response = await request('/api/admin/control', { method: 'POST', cookie, body: { action } });
    assert.equal(response.status, expectedStatus, response.text);
    return response;
  };
  const joinPlayer = async (name, extra = {}) => {
    const response = await request('/api/player/join', { method: 'POST', body: { name, ...extra } });
    assert.equal(response.status, 200, response.text);
    assert.ok(response.cookie);
    return { cookie: response.cookie, ...response.data };
  };
  const socket = (role, cookie) => {
    const client = connectSocket(url, {
      autoConnect: false, reconnection: false, transports: ['websocket'],
      auth: { role }, extraHeaders: cookie ? { Cookie: cookie } : {},
    });
    sockets.push(client);
    return client;
  };
  return {
    request, login, control, joinPlayer, socket, root, dataDir, questionsPath,
    at(value) { clock = value; },
    get arena() { return arena; },
    get url() { return url; },
    async restart() { await arena.close(); await start(); },
  };
}

function nextEvent(socket, event, predicate = () => true, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, receive);
      reject(new Error(`Timed out waiting for socket ${event}.`));
    }, timeoutMs);
    function receive(payload) {
      if (!predicate(payload)) return;
      socket.off(event, receive);
      clearTimeout(timer);
      resolve(payload);
    }
    socket.on(event, receive);
  });
}

async function connected(socket) {
  const ready = nextEvent(socket, 'connect');
  socket.connect();
  await ready;
  return socket;
}

function noAnswerKey(value) {
  assert.doesNotMatch(JSON.stringify(value), /"(?:correctIndex|answers|token|password)"\s*:/);
}

test('all admin endpoints require a session, login uses secure cookie attributes and logout revokes it', async (t) => {
  const f = await fixture(t);
  for (const [path, method, body] of [
    ['/api/admin/state', 'GET'],
    ['/api/admin/verify?q=Alex', 'GET'],
    ['/api/admin/results.csv', 'GET'],
    ['/api/admin/control', 'POST', { action: 'open' }],
    ['/api/admin/settings', 'POST', { hideLeaderboardNumbers: true }],
    ['/api/admin/kick', 'POST', { playerId: 'P-001' }],
    ['/api/admin/logout', 'POST', {}],
  ]) {
    const response = await f.request(path, { method, body });
    assert.equal(response.status, 401, `${method} ${path}: ${response.text}`);
  }
  assert.equal((await f.request('/api/admin/login', { method: 'POST', body: { ...credentials, password: 'incorrect' } })).status, 401);
  const login = await f.request('/api/admin/login', { method: 'POST', body: credentials });
  assert.equal(login.status, 200);
  assert.match(login.response.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(login.response.headers.get('set-cookie'), /SameSite=Strict/i);
  assert.doesNotMatch(JSON.stringify(login.data), /api-test-password-only/);
  assert.equal((await f.request('/api/admin/state', { cookie: login.cookie })).status, 200);
  assert.equal((await f.request('/api/admin/logout', { method: 'POST', cookie: login.cookie, body: {} })).status, 200);
  assert.equal((await f.request('/api/admin/state', { cookie: login.cookie })).status, 401);
});

test('admin sockets cannot spoof a role or survive session revocation', async (t) => {
  const f = await fixture(t);
  const unauthorized = f.socket('admin');
  const denied = nextEvent(unauthorized, 'connect_error');
  unauthorized.connect();
  assert.ok(await denied);
  assert.equal(unauthorized.connected, false);
  const cookie = await f.login();
  const admin = await connected(f.socket('admin', cookie));
  const stateChange = nextEvent(admin, 'admin', (payload) => payload.state.phase === 'lobby');
  await f.control(cookie, 'open');
  assert.equal((await stateChange).state.phase, 'lobby');
  const disconnected = nextEvent(admin, 'disconnect');
  assert.equal((await f.request('/api/admin/logout', { method: 'POST', cookie, body: {} })).status, 200);
  await disconnected;
  const revoked = f.socket('admin', cookie);
  const rejectedAgain = nextEvent(revoked, 'connect_error');
  revoked.connect();
  assert.ok(await rejectedAgain);
});

test('writes require JSON, reject foreign origins and validate malformed bodies', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const foreign = await f.request('/api/admin/control', {
    method: 'POST', cookie, body: { action: 'open' }, headers: { Origin: 'https://foreign.example' },
  });
  assert.equal(foreign.status, 403);
  const plain = await f.request('/api/admin/control', {
    method: 'POST', cookie, body: { action: 'open' }, headers: { 'Content-Type': 'text/plain' },
  });
  assert.equal(plain.status, 415);
  const malformed = await fetch(f.url + '/api/admin/control', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{broken',
  });
  assert.equal(malformed.status, 400);
  const malformedBody = await malformed.json();
  assert.equal(typeof malformedBody.error, 'string');
  assert.equal((await f.request('/api/admin/settings', { method: 'POST', cookie, body: { hideLeaderboardNumbers: 'yes' } })).status, 400);
  assert.equal((await f.request('/api/admin/control', { method: 'POST', cookie, body: { action: 'invented' } })).status, 400);
  const sameOrigin = await f.request('/api/admin/control', {
    method: 'POST', cookie, body: { action: 'open' }, headers: { Origin: f.url },
  });
  assert.equal(sameOrigin.status, 200, sameOrigin.text);
});

test('joining allows duplicate names, generates immutable IDs and resumes the same cookie', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/player/me')).status, 401);
  assert.equal((await f.request('/api/player/join', { method: 'POST', body: { name: 'Early' } })).status, 409);
  const admin = await f.login();
  await f.control(admin, 'open');
  for (const name of ['', '  ', null, 9, 'A'.repeat(81)]) {
    assert.equal((await f.request('/api/player/join', { method: 'POST', body: { name } })).status, 400);
  }
  const first = await f.joinPlayer(' Alex ', { id: 'P-999', playerId: 'P-999', token: 'chosen-token' });
  const second = await f.joinPlayer('Alex');
  assert.equal(first.player.name, 'Alex');
  assert.equal(second.player.name, 'Alex');
  assert.equal(first.player.id, 'P-001');
  assert.equal(second.player.id, 'P-002');
  assert.notEqual(first.cookie, second.cookie);
  assert.deepEqual(first.questions, []);
  noAnswerKey(first);
  const resumed = await f.request('/api/player/me', { cookie: first.cookie });
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumed.data.player, first.player);
  const repeatJoin = await f.request('/api/player/join', { method: 'POST', cookie: first.cookie, body: { name: 'New name', id: 'P-987' } });
  assert.equal(repeatJoin.status, 200);
  assert.equal(repeatJoin.data.player.id, first.player.id);
  assert.equal(repeatJoin.data.player.name, 'Alex');
  assert.equal((await f.request('/api/state')).data.state.playerCount, 2);
});

test('all players receive the full shared bank with stable shuffled original indexes and no answer key', async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  await f.control(admin, 'open');
  const first = await f.joinPlayer('One');
  const second = await f.joinPlayer('Two');
  const configured = await f.request('/api/config');
  assert.match(configured.data.joinUrl, /^http:\/\//);
  assert.match(configured.data.qrDataUrl, /^data:image\/png;base64,/);
  await f.control(admin, 'start');
  for (const player of [first, second]) {
    const me = await f.request('/api/player/me', { cookie: player.cookie });
    assert.equal(me.data.questions.length, bank.length);
    assert.deepEqual(me.data.questions.map((question) => question.question), bank.map((question) => question.question));
    for (const [index, question] of me.data.questions.entries()) {
      assert.deepEqual(question.options.map((option) => option.originalIndex).sort(), [0, 1, 2, 3]);
      for (const option of question.options) assert.equal(option.text, bank[index].options[option.originalIndex]);
    }
    assert.deepEqual((await f.request('/api/player/me', { cookie: player.cookie })).data.questions, me.data.questions);
    noAnswerKey(me.data);
  }
  for (const path of ['/api/state', '/api/config', '/api/leaderboard']) noAnswerKey((await f.request(path)).data);
  const preview = await f.request('/api/admin/state', { cookie: admin });
  assert.deepEqual(preview.data.questions, bank);
});

test('submissions are sequential and immutable, use server time, and reveal only the final aggregate', async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  await f.control(admin, 'open');
  const player = await f.joinPlayer('Contestant');
  await f.joinPlayer('Still playing');
  f.at(2_000_000);
  const started = await f.control(admin, 'start');
  const gameId = started.data.state.gameId;
  const answer = (questionIndex, optionIndex, extra = {}) => f.request('/api/player/answer', {
    method: 'POST', cookie: player.cookie, body: { gameId, questionIndex, optionIndex, ...extra },
  });
  assert.equal((await answer(1, 0)).status, 409);
  assert.equal((await answer(0, 2, { gameId: 'old-game' })).status, 409);
  assert.equal((await answer(0, '2')).status, 400);
  assert.equal((await answer(0, 4)).status, 400);
  assert.equal((await f.request('/api/player/answer', { method: 'POST', body: { gameId, questionIndex: 0, optionIndex: 2 } })).status, 401);
  const client = await connected(f.socket('player', player.cookie));
  const changed = nextEvent(client, 'player', (payload) => payload.player.progress === 1);
  f.at(2_001_000);
  const locked = await answer(0, 2, { totalTimeMs: 1, submittedAt: 1, correct: false });
  assert.equal(locked.status, 200);
  assert.equal(locked.data.player.progress, 1);
  assert.equal(locked.data.player.correct, null);
  assert.equal(locked.data.player.rank, null);
  assert.equal(locked.data.player.totalTimeMs, null);
  assert.equal(Object.hasOwn(locked.data, 'questions'), false);
  noAnswerKey(locked.data);
  const pushed = await changed;
  assert.equal(pushed.player.progress, 1);
  assert.equal(pushed.player.correct, null);
  assert.equal(Object.hasOwn(pushed, 'questions'), false);
  noAnswerKey(pushed);
  assert.equal((await answer(0, 0)).status, 409);
  assert.equal((await answer(2, 3)).status, 409);
  assert.equal((await answer(1, 1)).status, 200);
  f.at(2_008_000);
  const finished = await answer(2, 3, { totalTimeMs: 1 });
  assert.equal(finished.status, 200);
  assert.equal(finished.data.player.finished, true);
  assert.equal(finished.data.player.correct, 2);
  assert.equal(finished.data.player.totalTimeMs, 8_000);
  assert.equal(finished.data.player.rank, 1);
  assert.equal(finished.data.state.phase, 'running');
  assert.equal((await answer(2, 0)).status, 409);
  assert.equal((await f.request('/api/player/join', { method: 'POST', body: { name: 'Late' } })).status, 409);
});

test('privacy conceals leaderboard scores and order, while admin verification retains duplicate names', async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  await f.control(admin, 'open');
  const first = await f.joinPlayer('Alex');
  const second = await f.joinPlayer('Alex');
  const started = await f.control(admin, 'start');
  const gameId = started.data.state.gameId;
  const response = await f.request('/api/player/answer', { method: 'POST', cookie: second.cookie, body: { gameId, questionIndex: 0, optionIndex: 2 } });
  assert.equal(response.status, 200);
  assert.equal((await f.request('/api/admin/settings', { method: 'POST', cookie: admin, body: { hideLeaderboardNumbers: true } })).status, 200);
  const board = (await f.request('/api/leaderboard')).data.players;
  assert.deepEqual(board.map((player) => player.id), [first.player.id, second.player.id]);
  assert.ok(board.every((player) => player.correct === null && player.totalTimeMs === null && player.rank === null));
  assert.equal(board[1].progress, 1);
  const verified = await f.request('/api/admin/verify?q=Alex', { cookie: admin });
  assert.equal(verified.data.players.length, 2);
  assert.equal(verified.data.players[0].id, second.player.id);
  assert.equal(verified.data.players[0].correct, 1);
  const byId = await f.request(`/api/admin/verify?q=${second.player.id}`, { cookie: admin });
  assert.equal(byId.data.players.length, 1);
  assert.equal(byId.data.players[0].id, second.player.id);
  f.at(1_008_000);
  await f.control(admin, 'end');
  const final = (await f.request('/api/leaderboard')).data.players;
  assert.equal(final[0].id, second.player.id);
  assert.equal(final[0].rank, 1);
  assert.equal(final[0].correct, 1);
  assert.equal(final[0].totalTimeMs, 8_000);
  assert.ok(final.every((player) => player.finished && player.forced));
});

test('projector socket payload is limited to top ten and has no private data or socket mutations', async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  await f.control(admin, 'open');
  for (let i = 0; i < 12; i += 1) await f.joinPlayer(`Player ${i}`);
  const projector = await connected(f.socket('leaderboard'));
  const update = nextEvent(projector, 'leaderboard', (payload) => payload.state.phase === 'running');
  await f.control(admin, 'start');
  const payload = await update;
  assert.equal(payload.players.length, 10);
  assert.equal(Object.hasOwn(payload, 'questions'), false);
  noAnswerKey(payload);
  // Mutations belong exclusively to authenticated HTTP routes, not client socket events.
  const serverSocket = f.arena.io.sockets.sockets.get(projector.id);
  for (const event of ['admin:control', 'control', 'start', 'end', 'reset', 'admin:kick']) {
    assert.equal(serverSocket.listenerCount(event), 0, `${event} must have no mutation handler.`);
  }
  projector.emit(42, { action: 'end' }); // Socket.IO also permits numeric event names.
  const denial = await projector.timeout(4_000).emitWithAck('admin:control', { action: 'end' });
  assert.match(denial.error, /authentication/i);
  assert.equal((await f.request('/api/state')).data.state.phase, 'running');
});

test('kicking a player revokes access, disconnects its socket and retains other players', async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  await f.control(admin, 'open');
  const player = await f.joinPlayer('Removed');
  const kept = await f.joinPlayer('Kept');
  const socket = await connected(f.socket('player', player.cookie));
  const invalid = nextEvent(socket, 'session-invalid');
  const disconnected = nextEvent(socket, 'disconnect');
  const kick = await f.request('/api/admin/kick', { method: 'POST', cookie: admin, body: { playerId: player.player.id } });
  assert.equal(kick.status, 200);
  await invalid;
  await disconnected;
  assert.ok([401, 403].includes((await f.request('/api/player/me', { cookie: player.cookie })).status));
  assert.equal((await f.request('/api/player/me', { cookie: kept.cookie })).status, 200);
  const state = (await f.request('/api/admin/state', { cookie: admin })).data;
  assert.equal(state.state.playerCount, 1);
  assert.deepEqual(state.players.map((entry) => entry.id), [kept.player.id]);
});

test('CSV is final-only, ranks by score then time and escapes names safely', async (t) => {
  const f = await fixture(t, [bank[0]]);
  const admin = await f.login();
  await f.control(admin, 'open');
  const slower = await f.joinPlayer('=FORMULA("bad")');
  const faster = await f.joinPlayer('Comma, "Quote"');
  const incorrect = await f.joinPlayer('Alex');
  assert.equal((await f.request('/api/admin/results.csv', { cookie: admin })).status, 409);
  const started = await f.control(admin, 'start');
  const gameId = started.data.state.gameId;
  const answer = (player, optionIndex) => f.request('/api/player/answer', { method: 'POST', cookie: player.cookie, body: { gameId, questionIndex: 0, optionIndex } });
  f.at(1_000_500);
  await answer(incorrect, 0);
  f.at(1_001_000);
  await answer(faster, 2);
  f.at(1_003_000);
  await answer(slower, 2);
  const csv = await f.request('/api/admin/results.csv', { cookie: admin });
  assert.equal(csv.status, 200);
  assert.match(csv.response.headers.get('content-type'), /text\/csv/);
  assert.match(csv.response.headers.get('content-disposition'), /attachment/i);
  assert.ok(csv.text.indexOf(faster.player.id) < csv.text.indexOf(slower.player.id));
  assert.ok(csv.text.indexOf(slower.player.id) < csv.text.indexOf(incorrect.player.id));
  assert.match(csv.text, /"Comma, ""Quote"""/);
  assert.match(csv.text, /'=FORMULA\(""bad""\)/);
  assert.match(csv.text, /1\.000/);
  assert.match(csv.text, /3\.000/);
});

test('invalid reset is atomic, valid reset reloads questions and never reuses an ID', async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  await f.control(admin, 'open');
  const oldPlayer = await f.joinPlayer('Before reset');
  await f.control(admin, 'start');
  const before = (await f.request('/api/admin/state', { cookie: admin })).data;
  await writeFile(f.questionsPath, '[\n {"question": "bad"}\n]');
  const invalid = await f.request('/api/admin/control', { method: 'POST', cookie: admin, body: { action: 'reset' } });
  assert.ok(invalid.status >= 400 && invalid.status < 500, invalid.text);
  assert.match(invalid.data.error, /questions\.json:2:/);
  const unchanged = (await f.request('/api/admin/state', { cookie: admin })).data;
  assert.equal(unchanged.state.gameId, before.state.gameId);
  assert.equal(unchanged.state.phase, 'running');
  assert.deepEqual(unchanged.players, before.players);
  assert.deepEqual(unchanged.questions, before.questions);
  const changed = [{ ...bank[1], question: 'Replacement question' }];
  await writeFile(f.questionsPath, JSON.stringify(changed));
  const playerSocket = await connected(f.socket('player', oldPlayer.cookie));
  const invalidated = nextEvent(playerSocket, 'session-invalid');
  const reset = await f.control(admin, 'reset');
  await invalidated;
  assert.equal(reset.data.state.phase, 'closed');
  assert.equal(reset.data.state.totalQuestions, 1);
  assert.notEqual(reset.data.state.gameId, before.state.gameId);
  assert.equal((await f.request('/api/player/me', { cookie: oldPlayer.cookie })).status, 401);
  assert.deepEqual((await f.request('/api/admin/state', { cookie: admin })).data.questions, changed);
  await f.control(admin, 'open');
  const next = await f.joinPlayer('After reset');
  assert.equal(next.player.id, 'P-002');
  const files = await readdir(f.dataDir, { recursive: true });
  assert.ok(files.some((name) => /archive/i.test(name)), 'Reset creates a recoverable game archive.');
});

test('restart restores tokens, answer locks, elapsed time and question snapshot, then reset adopts file edits', async (t) => {
  const f = await fixture(t);
  let admin = await f.login();
  await f.control(admin, 'open');
  const player = await f.joinPlayer('Recovery');
  f.at(2_000_000);
  const started = await f.control(admin, 'start');
  const gameId = started.data.state.gameId;
  f.at(2_001_000);
  assert.equal((await f.request('/api/player/answer', { method: 'POST', cookie: player.cookie, body: { gameId, questionIndex: 0, optionIndex: 2 } })).status, 200);
  const original = (await f.request('/api/player/me', { cookie: player.cookie })).data.questions;
  await writeFile(f.questionsPath, JSON.stringify([bank[1]]));
  f.at(2_100_000);
  await f.restart();
  const restored = await f.request('/api/player/me', { cookie: player.cookie });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.data.state.gameId, gameId);
  assert.equal(restored.data.state.startedAt, 2_000_000);
  assert.equal(restored.data.state.questionFileChanged, true);
  assert.equal(restored.data.player.progress, 1);
  assert.deepEqual(restored.data.questions, original);
  assert.equal((await f.request('/api/player/answer', { method: 'POST', cookie: player.cookie, body: { gameId, questionIndex: 0, optionIndex: 0 } })).status, 409);
  for (const questionIndex of [1, 2]) {
    const response = await f.request('/api/player/answer', { method: 'POST', cookie: player.cookie, body: { gameId, questionIndex, optionIndex: bank[questionIndex].correctIndex } });
    assert.equal(response.status, 200, response.text);
  }
  const result = (await f.request('/api/player/me', { cookie: player.cookie })).data.player;
  assert.equal(result.correct, 3);
  assert.equal(result.totalTimeMs, 100_000);
  assert.equal(result.finished, true);
  await f.restart();
  assert.deepEqual((await f.request('/api/player/me', { cookie: player.cookie })).data.player, result);
  const saved = JSON.parse(await readFile(join(f.dataDir, 'state.json'), 'utf8'));
  assert.ok(JSON.stringify(saved).includes(player.player.id));
  admin = await f.login();
  await f.control(admin, 'reset');
  await f.control(admin, 'open');
  const next = await f.joinPlayer('Next game');
  assert.equal(next.player.id, 'P-002');
  assert.equal(next.state.totalQuestions, 1);
});

test('startup revalidates questions even when a saved game exists', async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  await f.control(admin, 'open');
  await f.joinPlayer('Saved player');
  await f.arena.close();
  await writeFile(f.questionsPath, 'not json');
  await assert.rejects(() => createArena({ dataDir: f.dataDir, questionsPath: f.questionsPath, credentials }), /Invalid question bank/);
});

test('the static frontend cannot expose credentials, persisted state or the question source', async (t) => {
  const f = await fixture(t);
  for (const path of ['/.env', '/.data/state.json', '/.data/id-counter.json', '/questions.json', '/server/app.js', '/package.json']) {
    const response = await f.request(path);
    assert.equal(response.status, 404, `${path} must remain outside the static root.`);
    assert.doesNotMatch(response.text, /api-test-password-only|"correctIndex"|"answers"/);
  }
});

test('public sockets never receive admin or another player payload and IDs cannot impersonate cookies', async (t) => {
  const f = await fixture(t, [bank[0]]);
  const admin = await f.login();
  await f.control(admin, 'open');
  const first = await f.joinPlayer('One');
  const second = await f.joinPlayer('Two');
  const observed = [];
  const spectators = [f.socket('spectator'), f.socket('leaderboard'), f.socket('player')];
  const privateClient = f.socket('player', second.cookie);
  for (const client of [...spectators, privateClient]) {
    client.on('admin', (payload) => observed.push({ client, event: 'admin', payload }));
    client.on('player', (payload) => observed.push({ client, event: 'player', payload }));
    await connected(client);
  }
  const started = await f.control(admin, 'start');
  const answer = { gameId: started.data.state.gameId, questionIndex: 0, optionIndex: 2, playerId: first.player.id, id: first.player.id };
  for (const cookie of [undefined, `arena_player=${first.player.id}`, 'arena_player=forged-token']) {
    const rejected = await f.request('/api/player/answer', { method: 'POST', cookie, body: answer });
    assert.equal(rejected.status, 401, 'Only the opaque player session authenticates an answer.');
  }
  assert.equal((await f.request('/api/player/answer', { method: 'POST', cookie: first.cookie, body: answer })).status, 200);
  await f.control(admin, 'end');
  // A transport barrier confirms all preceding broadcasts have arrived, without sleeps.
  for (const client of [...spectators, privateClient]) {
    const delivered = nextEvent(client, 'test:transport-barrier');
    f.arena.io.sockets.sockets.get(client.id).emit('test:transport-barrier');
    await delivered;
  }
  assert.equal(observed.filter(({ event }) => event === 'admin').length, 0);
  assert.equal(observed.filter(({ client, event }) => spectators.includes(client) && event === 'player').length, 0);
  const ownUpdates = observed.filter(({ client, event }) => client === privateClient && event === 'player');
  assert.ok(ownUpdates.length > 0);
  for (const { payload } of ownUpdates) {
    assert.equal(payload.player.id, second.player.id);
    noAnswerKey(payload);
  }
  const results = (await f.request('/api/admin/state', { cookie: admin })).data.players;
  assert.equal(results.find((player) => player.id === first.player.id).progress, 1);
  assert.equal(results.find((player) => player.id === second.player.id).progress, 0);
});

test('closing an arena repeatedly shares cleanup and does not fail', async (t) => {
  const f = await fixture(t);
  await connected(f.socket('spectator'));
  const firstClose = f.arena.close();
  const secondClose = f.arena.close();
  await Promise.all([firstClose, secondClose]);
  await f.arena.close();
  assert.equal(f.arena.httpServer.listening, false);
});

test('concurrent final answers publish one phase transition instead of one broadcast per player', async (t) => {
  const f = await fixture(t, [bank[0]]);
  const admin = await f.login();
  await f.control(admin, 'open');
  const players = await Promise.all(Array.from({ length: 20 }, (_, index) => f.joinPlayer(`Finisher ${index}`)));
  const projector = await connected(f.socket('leaderboard'));
  let finalBroadcasts = 0;
  projector.on('leaderboard', payload => { if (payload.state.phase === 'finished') finalBroadcasts += 1; });
  const started = await f.control(admin, 'start');
  const answers = await Promise.all(players.map(player => f.request('/api/player/answer', {
    method: 'POST', cookie: player.cookie,
    body: { gameId: started.data.state.gameId, questionIndex: 0, optionIndex: 2 },
  })));
  for (const answer of answers) {
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.data.player.finished, true);
  }
  await new Promise(resolve => setImmediate(resolve));
  const delivered = nextEvent(projector, 'test:transport-barrier');
  f.arena.io.sockets.sockets.get(projector.id).emit('test:transport-barrier');
  await delivered;
  assert.ok(finalBroadcasts >= 1, 'The projector must receive the final state.');
  // Allow a pending coalesced update alongside the single actual phase transition.
  assert.ok(finalBroadcasts <= 3, `One burst of finishers caused ${finalBroadcasts} final broadcasts.`);
  const final = (await f.request('/api/admin/state', { cookie: admin })).data;
  assert.equal(final.state.finishedCount, 20);
  assert.equal(final.state.phase, 'finished');
});
