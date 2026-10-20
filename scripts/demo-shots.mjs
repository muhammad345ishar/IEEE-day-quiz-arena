// Takes full-resolution PNG screenshots of a running arena (default: the demo on :3001)
// using headless Chrome. Read-only: it never starts, ends or resets a game.
// Usage: node scripts/demo-shots.mjs <prefix>      e.g. live  ->  demo-shots/live-leaderboard.png
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prefix = process.argv[2] ?? 'shot';
const base = 'http://localhost:3001';
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const outDir = path.join(root, 'demo-shots');
mkdirSync(outDir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const env = Object.fromEntries(readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
  .map(l => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map(m => [m[1], m[2]]));

const profile = mkdtempSync(path.join(tmpdir(), 'arena-shots-'));
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    try { targets = await (await fetch('http://127.0.0.1:9333/json/list')).json(); } catch { await sleep(200); }
  }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const view = (width, height, dpr = 1, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
  const go = async (url, wait = 3000) => { await send('Page.navigate', { url }); await sleep(wait); };
  const snap = async name => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outDir, `${prefix}-${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('saved', path.relative(root, file));
  };
  const evalJs = expression => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  await send('Page.enable');

  // Projector leaderboard, 1080p
  await view(1920, 1080, 1);
  await go(`${base}/leaderboard`);
  await snap('leaderboard');

  // Admin console (sign in with the .env credentials, never printed), full page height
  await view(1440, 900, 1);
  await go(`${base}/admin`, 1500);
  const status = await evalJs(`fetch('/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({ username: env.ADMIN_USER, password: env.ADMIN_PASS })})}).then(r=>r.status)`);
  if (status.result.value !== 200) throw new Error(`admin login failed (${status.result.value})`);
  await go(`${base}/admin`, 3000);
  const { result } = await evalJs('document.documentElement.scrollHeight');
  await view(1440, Math.min(Math.max(900, result.value), 3000), 1);
  await sleep(800);
  await snap('admin');

  ws.close();
} finally {
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
