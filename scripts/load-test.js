import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { io } from 'socket.io-client';
import { createArena } from '../server/app.js';
import { loadQuestions } from '../server/questions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: npm run test:load -- [--players 50]\nRuns an isolated full game using root questions.json; never changes the event game.';

function playerCount(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return null;
  if (args.length === 0) return 50;
  let value;
  if (args.length === 2 && args[0] === '--players') value = args[1];
  else if (args.length === 1 && args[0].startsWith('--players=')) value = args[0].slice('--players='.length);
  else throw new Error(usage);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('--players must be a positive safe integer.\n' + usage);
  }
  return Number(value);
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = percentile => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1)] : 0;
  const rounded = value => Math.round(value * 10) / 10;
  return { p50: rounded(at(0.50)), p95: rounded(at(0.95)), max: rounded(sorted.at(-1) ?? 0) };
}

async function allOrFail(promises, label) {
  const results = await Promise.allSettled(promises);
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length) {
    throw new Error(`${label}: ${failed.length} failed. ${failed.slice(0, 5).map(result => result.reason.message).join(' | ')}`);
  }
  return results.map(result => result.value);
}

async function run(count) {
  const began = performance.now();
  const generatedAt = new Date().toISOString();
  const questionsPath = path.join(root, 'questions.json');
  const questions = loadQuestions(questionsPath);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ieee-arena-load-'));
  const credentials = { username: 'load-test-admin', password: randomBytes(24).toString('base64url') };
  const abort = new AbortController();
  const timeoutMs = Math.max(120_000, questions.length * 500 + count * 200);
  const deadline = setTimeout(() => abort.abort(new Error(`Load test exceeded ${timeoutMs / 1000} seconds.`)), timeoutMs);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  const sockets = [];
  const bots = [];
  const answerLatencies = [];
  const privacyErrors = [];
  let arena, baseUrl, failure, closingSockets = false;
  let acknowledgedAnswers = 0, playerEvents = 0, leaderboardEvents = 0;
  let maxPlayerPayloadBytes = 0, maxLeaderboardPayloadBytes = 0;
  let gameplayDurationMs = 0, peakSockets = 0, finalPlayerCount = 0;
  let restartVerified = false, csvRows = 0, gameId;

  const violation = message => { if (privacyErrors.length < 20) privacyErrors.push(message); };
  const noSecrets = payload => !/"(?:correctIndex|answers|token|password|questions)"\s*:/.test(JSON.stringify(payload));
  const request = async (route, cookie, body) => {
    const response = await fetch(baseUrl + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
    });
    const data = route.endsWith('.csv') ? await response.text() : await response.json();
    assert.equal(response.status, 200, `${route}: ${typeof data === 'string' ? data.slice(0, 200) : data.error}`);
    return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const launch = async () => {
    arena = await createArena({ dataDir, questionsPath, credentials, port: 0 });
    ({ url: baseUrl } = await arena.listen(0, '127.0.0.1'));
  };
  const connect = async (role, cookie, bot) => {
    const socket = io(baseUrl, {
      autoConnect: false, reconnection: false, timeout: 10_000,
      transports: ['websocket'], auth: { role }, extraHeaders: cookie ? { Cookie: cookie } : {},
    });
    sockets.push(socket);
    socket.on('admin', () => violation(`${role} socket received an admin payload.`));
    socket.on('session-invalid', () => violation(`${role} socket was unexpectedly invalidated.`));
    socket.on('server-error', payload => violation(`Server error: ${payload.error}`));
    socket.on('disconnect', reason => { if (!closingSockets) violation(`${role} socket disconnected during gameplay: ${reason}`); });
    socket.on('state', payload => { if (!noSecrets(payload)) violation('Public state exposed private fields.'); });
    socket.on('player', payload => {
      playerEvents += 1;
      if (!payload?.player) { violation('Malformed player socket update.'); return; }
      maxPlayerPayloadBytes = Math.max(maxPlayerPayloadBytes, Buffer.byteLength(JSON.stringify(payload)));
      if (role !== 'player' || payload.player?.id !== bot.id) violation('A socket received another player identity.');
      if (!noSecrets(payload)) violation('A player update exposed private data or repeated the question bank.');
      if (!payload.player.finished && [payload.player.correct, payload.player.rank, payload.player.totalTimeMs].some(value => value !== null)) {
        violation('An unfinished player received correctness or result data.');
      }
    });
    socket.on('leaderboard', payload => {
      leaderboardEvents += 1;
      if (!Array.isArray(payload?.players)) { violation('Malformed projector socket update.'); return; }
      maxLeaderboardPayloadBytes = Math.max(maxLeaderboardPayloadBytes, Buffer.byteLength(JSON.stringify(payload)));
      if (role !== 'leaderboard') violation('A player socket received the projector stream.');
      if (payload.players.length > 10) violation('Projector update exceeded ten players.');
      if (!noSecrets(payload)) violation('Projector update exposed private data or question bank.');
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.disconnect(); reject(new Error(`Timed out connecting ${role}.`)); }, 12_000);
      const connected = () => { clearTimeout(timer); socket.off('connect_error', rejected); resolve(); };
      const rejected = error => { clearTimeout(timer); socket.off('connect', connected); reject(error); };
      socket.once('connect', connected);
      socket.once('connect_error', rejected);
      socket.connect();
    });
    return socket;
  };
  const transportBarrier = async socket => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('A socket stopped receiving updates.')), 5_000);
      socket.once('test:barrier', () => { clearTimeout(timer); resolve(); });
      const serverSocket = arena.io.sockets.sockets.get(socket.id);
      if (!serverSocket) { clearTimeout(timer); reject(new Error('An expected socket is disconnected.')); return; }
      serverSocket.emit('test:barrier');
    });
  };

  eventLoop.enable();
  try {
    console.log(`Rehearsing ${count} players × ${questions.length} questions using isolated temporary state.`);
    await launch();
    const { cookie: admin } = await request('/api/admin/login', undefined, credentials);
    const { data: preview } = await request('/api/admin/state', admin);
    assert.deepEqual(preview.questions, questions, 'The admin bank must match root questions.json.');
    await request('/api/admin/control', admin, { action: 'open' });
    const joined = await allOrFail(Array.from({ length: count }, async (_, index) => {
      const name = index % 5 < 2 ? 'Circuit Crew' : `Bot ${String(index + 1).padStart(3, '0')}`;
      const { data, cookie } = await request('/api/player/join', undefined, { name });
      assert.ok(cookie, 'Every bot must receive a session cookie.');
      assert.equal(data.player.name, name);
      assert.deepEqual(data.questions, []);
      return { index, id: data.player.id, cookie, name, thinkMs: 15 + (index % 8) * 15, correctTarget: (index * 7) % (questions.length + 1) };
    }), 'Joining players');
    bots.push(...joined);
    assert.equal(new Set(bots.map(bot => bot.id)).size, count, 'Player IDs must be unique.');
    assert.equal(new Set(bots.map(bot => bot.cookie)).size, count, 'Player session tokens must be unique.');
    await allOrFail(bots.map(async bot => { bot.socket = await connect('player', bot.cookie, bot); }), 'Connecting player sockets');
    const boardSocket = await connect('leaderboard');
    peakSockets = arena.io.sockets.sockets.size;
    assert.equal(peakSockets, count + 1, 'All player sockets and the projector must be connected simultaneously.');

    const gameBegan = performance.now();
    const { data: start } = await request('/api/admin/control', admin, { action: 'start' });
    gameId = start.state.gameId;
    assert.equal(start.state.playerCount, count);
    assert.equal(start.state.phase, 'running');
    // Every bot downloads the entire bank once, in the shared question order.
    await allOrFail(bots.map(async bot => {
      const { data: me } = await request('/api/player/me', bot.cookie);
      assert.equal(me.state.startedAt, start.state.startedAt);
      assert.equal(me.questions.length, questions.length);
      assert.deepEqual(me.questions.map(question => question.question), questions.map(question => question.question));
      assert.doesNotMatch(JSON.stringify(me), /"(?:correctIndex|answers|token|password)"\s*:/, 'Player question bank must omit private fields.');
      for (const [index, question] of me.questions.entries()) {
        assert.deepEqual(question.options.map(option => option.originalIndex).sort(), [0, 1, 2, 3]);
        for (const option of question.options) assert.equal(option.text, questions[index].options[option.originalIndex]);
      }
      bot.questions = me.questions;
      bot.expectedAnswers = questions.map((question, index) => {
        const correct = (index + bot.index) % questions.length < bot.correctTarget;
        return correct ? question.correctIndex : (question.correctIndex + 1 + bot.index % 3) % 4;
      });
    }), 'Downloading player question banks');

    await allOrFail(bots.map(async bot => {
      for (const [questionIndex, optionIndex] of bot.expectedAnswers.entries()) {
        await delay(bot.thinkMs);
        const sentAt = performance.now();
        const { data } = await request('/api/player/answer', bot.cookie, { gameId, questionIndex, optionIndex });
        answerLatencies.push(performance.now() - sentAt);
        acknowledgedAnswers += 1;
        assert.ok(noSecrets(data), 'Answer acknowledgement must contain no private fields or question bank.');
        assert.equal(data.player.id, bot.id);
        assert.equal(data.player.progress, questionIndex + 1);
        if (questionIndex < questions.length - 1) assert.equal(data.player.correct, null);
        else {
          assert.equal(data.player.finished, true);
          assert.equal(data.player.correct, bot.correctTarget);
          assert.ok(Number.isFinite(data.player.totalTimeMs) && data.player.totalTimeMs >= 0);
        }
      }
    }), 'Answering the full game');
    gameplayDurationMs = performance.now() - gameBegan;
    await allOrFail([...bots.map(bot => bot.socket), boardSocket].map(transportBarrier), 'Delivering final socket updates');
    assert.deepEqual(privacyErrors, [], 'Socket privacy/availability checks failed.');
    assert.ok(leaderboardEvents > 0 && playerEvents >= acknowledgedAnswers);
    assert.equal(acknowledgedAnswers, count * questions.length);

    const { data: final } = await request('/api/admin/state', admin);
    assert.equal(final.state.phase, 'finished');
    assert.equal(final.state.finishedCount, count);
    assert.equal(final.players.length, count);
    finalPlayerCount = final.players.length;
    // Each HTTP success was already durable; inspect disk independently of the game methods.
    const saved = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'));
    assert.equal(saved.players.length, count);
    assert.equal(saved.phase, 'finished');
    const expected = bots.map(bot => {
      const player = saved.players.find(entry => entry.id === bot.id);
      assert.ok(player);
      assert.equal(player.startedAt, start.state.startedAt, 'All players share one server start.');
      assert.equal(player.answers.length, questions.length);
      assert.equal(new Set(player.answers.map(answer => answer.questionIndex)).size, questions.length);
      for (const [index, answer] of player.answers.entries()) {
        assert.equal(answer.questionIndex, index);
        assert.equal(answer.optionIndex, bot.expectedAnswers[index]);
        assert.equal(answer.correct, answer.optionIndex === questions[index].correctIndex);
      }
      const correct = bot.expectedAnswers.reduce((sum, optionIndex, index) => sum + Number(optionIndex === questions[index].correctIndex), 0);
      assert.equal(correct, bot.correctTarget);
      assert.equal(player.correct, correct);
      assert.equal(player.totalTimeMs, player.finishedAt - start.state.startedAt);
      assert.ok(player.finishedAt <= saved.endedAt);
      assert.equal(player.forced, false);
      return { id: bot.id, correct, totalTimeMs: player.totalTimeMs, finishedAt: player.finishedAt, finishSequence: player.finishSequence };
    }).sort((left, right) => right.correct - left.correct || left.totalTimeMs - right.totalTimeMs || left.finishedAt - right.finishedAt || left.finishSequence - right.finishSequence);
    assert.deepEqual(final.players.map(player => player.id), expected.map(player => player.id), 'Independent ranking must match the server.');
    assert.deepEqual(final.players.map(player => player.rank), Array.from({ length: count }, (_, i) => i + 1));
    const { data: board } = await request('/api/leaderboard');
    assert.deepEqual(board.players.map(player => player.id), expected.slice(0, 10).map(player => player.id));
    const { data: csv } = await request('/api/admin/results.csv', admin);
    const lines = csv.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
    csvRows = lines.length - 1;
    assert.equal(lines[0], 'rank,name,ID,correct,total time');
    assert.equal(csvRows, count);
    expected.forEach((player, index) => assert.ok(lines[index + 1].includes(`"${player.id}"`), 'CSV order must match the final ranking.'));

    // Reuse the same isolated files and player cookies across an actual server restart.
    closingSockets = true;
    sockets.forEach(socket => socket.disconnect());
    await arena.close();
    await launch();
    await allOrFail(bots.map(async bot => {
      const { data: me } = await request('/api/player/me', bot.cookie);
      assert.equal(me.state.gameId, gameId);
      assert.equal(me.state.startedAt, start.state.startedAt);
      assert.equal(me.state.phase, 'finished');
      const before = final.players.find(player => player.id === bot.id);
      for (const key of ['id', 'name', 'progress', 'finished', 'forced', 'correct', 'totalTimeMs', 'rank']) assert.equal(me.player[key], before[key]);
      assert.deepEqual(me.questions, bot.questions, 'Restart must preserve the player option order.');
    }), 'Restoring every player after restart');
    restartVerified = true;
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(deadline);
    eventLoop.disable();
    closingSockets = true;
    const cleanup = await Promise.allSettled(sockets.map(async socket => socket.disconnect()));
    for (const result of cleanup) if (result.status === 'rejected') failure ??= result.reason;
    try { await arena?.close(); } catch (error) { failure ??= error; }
    try { await rm(dataDir, { recursive: true, force: true }); } catch (error) { failure ??= error; }
  }

  const rounded = value => Math.round(value * 10) / 10;
  const report = {
    status: failure ? 'failed' : 'passed', generatedAt, node: process.version,
    players: count, questions: questions.length, answers: acknowledgedAnswers,
    expectedAnswers: count * questions.length, finalPlayers: finalPlayerCount,
    simultaneousPlayerSockets: Math.min(count, Math.max(0, peakSockets - 1)), peakSockets,
    duplicateNames: count - new Set(bots.map(bot => bot.name)).size,
    totalDurationMs: rounded(performance.now() - began), gameplayDurationMs: rounded(gameplayDurationMs),
    answerLatencyMs: summarize(answerLatencies), eventLoopP95Ms: rounded(eventLoop.percentile(95) / 1e6),
    maxPlayerPayloadKB: rounded(maxPlayerPayloadBytes / 1024), maxLeaderboardPayloadKB: rounded(maxLeaderboardPayloadBytes / 1024),
    playerEvents, leaderboardEvents, privacyErrors, csvRows, restartVerified,
    ...(failure ? { error: failure.message } : {}),
  };
  const artifact = path.join(root, 'artifacts', `load-test-${count}.json`);
  await mkdir(path.dirname(artifact), { recursive: true });
  await writeFile(artifact, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report: ${artifact}`);
  if (failure) process.exitCode = 1;
}

try {
  const count = playerCount(process.argv.slice(2));
  if (count === null) console.log(usage);
  else await run(count);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
