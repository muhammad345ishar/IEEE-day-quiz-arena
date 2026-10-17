import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { QuizGame, GameError } from './game.js';
import { loadQuestions } from './questions.js';
import { JsonStore } from './persistence.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_COOKIE = 'arena_admin';
const PLAYER_COOKIE = 'arena_player';
const SESSION_MS = 12 * 60 * 60 * 1000;

function cookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const at = part.indexOf('=');
    return at < 0 ? ['', ''] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
  }));
}
function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function sameOrigin(headers) {
  if (!headers.origin) return true; // Native clients and same-origin GETs have no Origin.
  try { return new URL(headers.origin).host === headers.host; } catch { return false; }
}
function cookieOptions(maxAge) {
  return { httpOnly: true, sameSite: 'strict', path: '/', maxAge };
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** HTTP writes are guarded; sockets only subscribe to carefully scoped live views. */
export async function createArena({ dataDir = path.join(root, '.data'), questionsPath = path.join(root, 'questions.json'), credentials, lanHost = '127.0.0.1', port = 3000, now } = {}) {
  if (!credentials?.username || !credentials?.password) throw new Error('Admin credentials are required.');
  // A monotonic clock avoids local clock adjustments during a run; restart includes real downtime.
  const wallAnchor = Date.now(), monotonicAnchor = performance.now();
  const clock = now ?? (() => Math.floor(wallAnchor + performance.now() - monotonicAnchor));
  let diskQuestions = loadQuestions(questionsPath);
  const store = new JsonStore(dataDir);
  const { saved, counter } = await store.init();
  const game = new QuizGame({ questions: diskQuestions, saved, now: clock });
  game.idCounter = Math.max(game.idCounter, counter);
  let questionFileChanged = JSON.stringify(game.questions) !== JSON.stringify(diskQuestions);
  await store.save(game.serialize());
  const sessions = new Map(), loginAttempts = new Map();
  let tokenToId = new Map([...game.players.values()].map(player => [player.token, player.id]));
  let joinUrl = `http://${lanHost}:${port}`, qrDataUrl = '';
  let broadcastTimer, closing, broken = false, resetting = false;
  const app = express();
  app.disable('x-powered-by');
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    maxHttpBufferSize: 16384,
    serveClient: false,
    allowRequest: (req, callback) => callback(null, sameOrigin(req.headers)),
  });

  const state = () => ({ ...game.stateView(), joinUrl, questionFileChanged });
  const envelope = () => ({ state: state(), serverNow: clock() });
  const adminSession = headers => {
    const token = cookies(headers.cookie)[ADMIN_COOKIE];
    const session = sessions.get(token);
    if (!session || session.expires <= Date.now()) { sessions.delete(token); return null; }
    return token;
  };
  const playerId = headers => {
    const id = tokenToId.get(cookies(headers.cookie)[PLAYER_COOKIE]);
    game.requirePlayer(id);
    return id;
  };
  const playerPayload = (id, withQuestions = false) => ({
    ...envelope(), player: game.playerView(id),
    ...(withQuestions ? { questions: game.questionsForPlayer(id) } : {}),
  });
  const adminPayload = () => ({ ...envelope(), players: game.leaderboard({ admin: true, limit: Infinity }) });
  const leaderboardPayload = () => ({ ...envelope(), players: game.leaderboard() });
  const checkWritable = () => {
    if (broken) throw new GameError('Saving failed. Restart the server after checking the disk.', 503);
    if (resetting) throw new GameError('The game is resetting. Please try again.', 409);
  };
  const persist = async () => {
    try { await store.save(game.serialize({ clone: false })); }
    catch (error) {
      broken = true;
      io.emit('server-error', { error: 'Game saving failed. Ask the host to check the server.' });
      console.error('Game saving failed:', error.message);
      throw new GameError('Could not save the game. Contact the host before continuing.', 503);
    }
  };
  function broadcast() {
    broadcastTimer = undefined;
    if (broken) return;
    io.emit('state', envelope());
    io.to('leaderboard').emit('leaderboard', leaderboardPayload());
    // Recheck the session on every privileged emission, including expiry and logout.
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.role === 'admin') {
        if (!adminSession(socket.handshake.headers)) socket.disconnect(true);
        else socket.emit('admin', adminPayload());
      }
    }
    for (const player of game.activePlayers()) {
      if (player.finishedAt !== null) io.to(`player:${player.id}`).emit('player', playerPayload(player.id));
    }
  }
  function publish(immediate = false) {
    if (broadcastTimer) clearTimeout(broadcastTimer);
    if (immediate) broadcast();
    else broadcastTimer = setTimeout(broadcast, 120);
  }
  // During a sustained answer stream do not starve the projector by resetting its timer.
  function schedule() { if (!broadcastTimer) broadcastTimer = setTimeout(broadcast, 120); }
  async function mutate(fn) {
    checkWritable();
    const before = game.phase;
    const value = fn();
    const phaseChanged = game.phase !== before;
    await persist();
    // Only the mutation that changes phase broadcasts immediately. Other writes
    // may finish saving together, after the final answer has ended the game.
    if (phaseChanged) publish(true); else schedule();
    return value;
  }

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, res, next) => {
    if (broken) return res.status(503).json({ error: 'Game saving failed. Ask the host to restart after checking the disk.' });
    if (!sameOrigin(req.headers)) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'Send application/json.' });
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/state', (req, res) => res.json(envelope()));
  app.get('/api/config', (req, res) => res.json({ joinUrl, qrDataUrl }));
  app.get('/api/leaderboard', (req, res) => res.json(leaderboardPayload()));
  app.get('/api/player/me', (req, res) => res.json(playerPayload(playerId(req.headers), true)));
  app.post('/api/player/join', async (req, res) => {
    const existing = tokenToId.get(cookies(req.headers.cookie)[PLAYER_COOKIE]);
    if (existing && !game.players.get(existing)?.kicked) return res.json(playerPayload(existing, true));
    const player = await mutate(() => {
      const joined = game.join(req.body?.name);
      tokenToId.set(joined.token, joined.id);
      return joined;
    });
    res.cookie(PLAYER_COOKIE, player.token, cookieOptions(365 * 86400000));
    res.json(playerPayload(player.id, true));
  });
  app.post('/api/player/answer', async (req, res) => {
    const id = playerId(req.headers);
    await mutate(() => game.answer(id, req.body ?? {}));
    const payload = playerPayload(id);
    io.to(`player:${id}`).emit('player', payload);
    res.json(payload);
  });

  app.post('/api/admin/login', (req, res) => {
    const ip = req.ip;
    const time = Date.now();
    let attempts = loginAttempts.get(ip);
    if (!attempts || attempts.until < time) attempts = { count: 0, until: time + 60000 };
    if (attempts.count >= 20) return res.status(429).json({ error: 'Too many login attempts. Try again in a minute.' });
    if (!equalSecret(req.body?.username, credentials.username) || !equalSecret(req.body?.password, credentials.password)) {
      attempts.count++;
      loginAttempts.set(ip, attempts);
      return res.status(401).json({ error: 'Incorrect username or password.' });
    }
    loginAttempts.delete(ip);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { expires: time + SESSION_MS });
    res.cookie(ADMIN_COOKIE, token, cookieOptions(SESSION_MS));
    res.json({ ok: true });
  });
  app.use('/api/admin', (req, res, next) => {
    req.adminToken = adminSession(req.headers);
    if (!req.adminToken) return res.status(401).json({ error: 'Sign in to the admin console.' });
    next();
  });
  app.post('/api/admin/logout', (req, res) => {
    sessions.delete(req.adminToken);
    for (const socket of io.sockets.sockets.values()) {
      if (cookies(socket.handshake.headers.cookie)[ADMIN_COOKIE] === req.adminToken && socket.data.role === 'admin') socket.disconnect(true);
    }
    res.clearCookie(ADMIN_COOKIE, cookieOptions(0));
    res.json({ ok: true });
  });
  app.get('/api/admin/state', (req, res) => res.json({ ...adminPayload(), questions: game.questions }));
  app.post('/api/admin/control', async (req, res) => {
    const action = req.body?.action;
    if (action === 'reset') {
      checkWritable();
      // Validate first: a typo must never destroy an event already in progress.
      let fresh;
      try { fresh = loadQuestions(questionsPath); } catch (error) { throw new GameError(error.message, 400); }
      resetting = true;
      try {
        await store.flush();
        await store.archive(game.serialize());
        game.reset(fresh);
        diskQuestions = fresh;
        questionFileChanged = false;
        tokenToId.clear();
        await persist();
        for (const socket of io.sockets.sockets.values()) {
          if (socket.data.playerId) {
            socket.emit('session-invalid', { error: 'A new game is ready. Join again to get your new ID.' });
            socket.leave(`player:${socket.data.playerId}`);
            socket.data.playerId = null;
          }
        }
      } finally { resetting = false; }
      publish(true);
    } else {
      if (!['open', 'start', 'end'].includes(action)) throw new GameError('Unknown game action.');
      await mutate(() => game[action]());
      publish(true);
    }
    res.json(envelope());
  });
  app.post('/api/admin/settings', async (req, res) => {
    await mutate(() => game.setHide(req.body?.hideLeaderboardNumbers));
    publish(true);
    res.json(envelope());
  });
  app.post('/api/admin/kick', async (req, res) => {
    const id = req.body?.playerId;
    await mutate(() => game.kick(id));
    io.to(`player:${id}`).emit('session-invalid', { error: 'The host removed you from this game.' });
    io.in(`player:${id}`).disconnectSockets(true);
    res.json(envelope());
  });
  app.get('/api/admin/verify', (req, res) => {
    const query = String(req.query.q ?? '').trim().toLocaleLowerCase();
    const players = game.leaderboard({ admin: true, limit: Infinity });
    res.json({ players: query ? players.filter(p => p.id.toLowerCase().includes(query) || p.name.toLocaleLowerCase().includes(query)) : [] });
  });
  app.get('/api/admin/results.csv', (req, res) => {
    if (game.phase !== 'finished') throw new GameError('End the quiz before exporting final results.', 409);
    const lines = ['rank,name,ID,correct,total time'];
    for (const p of game.leaderboard({ admin: true, limit: Infinity })) {
      lines.push([p.rank, p.name, p.id, p.correct, (p.totalTimeMs / 1000).toFixed(3)].map(csvCell).join(','));
    }
    res.type('text/csv').attachment(`ieee-day-results-${game.gameId.slice(0, 8)}.csv`).send('\uFEFF' + lines.join('\r\n') + '\r\n');
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
  app.use(express.static(path.join(root, 'dist'), { index: false, dotfiles: 'deny' }));
  app.get(['/', '/admin', '/leaderboard'], (req, res) => {
    const index = path.join(root, 'dist', 'index.html');
    if (!existsSync(index)) return res.status(503).type('text').send('Run npm run build, then npm start.');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status ?? 500;
    if (status >= 500) console.error(error.message);
    res.status(status).json({ error: status === 500 ? 'Unexpected server error. Check the host terminal.' : error.message });
  });

  io.use((socket, next) => {
    if (!sameOrigin(socket.handshake.headers)) return next(new Error('Cross-origin connection denied.'));
    const role = socket.handshake.auth?.role ?? 'spectator';
    if (!['player', 'admin', 'leaderboard', 'spectator'].includes(role)) return next(new Error('Unknown socket role.'));
    if (role === 'admin' && !adminSession(socket.handshake.headers)) return next(new Error('Admin authentication required.'));
    socket.data.role = role;
    next();
  });
  io.on('connection', socket => {
    const role = socket.data.role;
    if (role === 'leaderboard') { socket.join('leaderboard'); socket.emit('leaderboard', leaderboardPayload()); }
    if (role === 'admin') socket.emit('admin', adminPayload());
    if (role === 'player') {
      try {
        const id = playerId(socket.handshake.headers);
        socket.data.playerId = id;
        socket.join(`player:${id}`);
        socket.emit('player', playerPayload(id));
      } catch { /* An unjoined player still needs lobby state updates. */ }
    }
    socket.emit('state', envelope());
    socket.onAny((event, ...args) => {
      if (typeof event === 'string' && event.startsWith('admin')) {
        const authenticated = adminSession(socket.handshake.headers);
        const ack = args.at(-1);
        if (typeof ack === 'function') ack({ error: authenticated ? 'Use authenticated HTTP controls.' : 'Admin authentication required.' });
        if (!authenticated) socket.disconnect(true);
      }
    });
  });
  const sweep = setInterval(() => {
    for (const [token, session] of sessions) if (session.expires <= Date.now()) sessions.delete(token);
    for (const [ip, attempts] of loginAttempts) if (attempts.until <= Date.now()) loginAttempts.delete(ip);
    for (const socket of io.sockets.sockets.values()) if (socket.data.role === 'admin' && !adminSession(socket.handshake.headers)) socket.disconnect(true);
  }, 30000);
  sweep.unref();

  return {
    app, httpServer, io, game,
    async listen(listenPort = port, host = '0.0.0.0') {
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(listenPort, host, () => { httpServer.off('error', reject); resolve(); });
      });
      const actualPort = httpServer.address().port;
      joinUrl = `http://${lanHost}:${actualPort}`;
      qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 2, width: 320, color: { dark: '#172321', light: '#ffffff' } });
      return { port: actualPort, url: joinUrl };
    },
    close() {
      closing ??= (async () => {
        clearInterval(sweep);
        clearTimeout(broadcastTimer);
        try { await store.flush(); }
        finally {
          await new Promise(resolve => io.close(resolve));
          if (httpServer.listening) await new Promise(resolve => httpServer.close(resolve));
        }
      })();
      return closing;
    },
  };
}
