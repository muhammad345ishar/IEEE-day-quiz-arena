// Captures the PARTICIPANT (phone) screens of the arena with headless Chrome:
//   player-1-join, player-2-waiting, player-3-question, player-4-locked, player-5-result
// It joins the lobby as "Demo Player", waits for the host to start the quiz, answers every
// question, then screenshots the result. It never touches admin controls or other players.
// Usage: node scripts/demo-player-shots.mjs      (start it BEFORE you press Enter at LOBBY READY)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.BASE ?? 'http://localhost:3001';
const chromePath = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const debugPort = process.env.DEBUG_PORT ?? '9334';
const outDir = process.env.OUT_DIR ?? path.join(root, 'demo-shots');
const playerName = process.env.PLAYER_NAME ?? 'Demo Player';
mkdirSync(outDir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const profile = mkdtempSync(path.join(tmpdir(), 'arena-player-'));
const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); } catch { await sleep(200); }
  }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  const view = (height = 812) => send('Emulation.setDeviceMetricsOverride', { width: 375, height, deviceScaleFactor: 3, mobile: true });
  const snap = async name => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
    log('saved', `${name}.png`);
  };
  const waitFor = async (check, label, timeoutMs = 15 * 60 * 1000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (await js(check)) return; await sleep(250); }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const phaseIs = p => `fetch('/api/state').then(r=>r.json()).then(j=>j.state.phase==='${p}')`;

  await send('Page.enable');
  await view();
  await send('Page.navigate', { url: `${base}/` });
  await sleep(2000);
  log('Waiting for the lobby to open (run the seeder and let it reach LOBBY READY)...');
  await waitFor(phaseIs('lobby'), 'the lobby');
  await sleep(1000);

  // 1. join screen with a name typed in
  await js(`document.querySelector('#player-name').focus()`);
  await send('Input.insertText', { text: playerName });
  await sleep(300);
  await js(`document.querySelector('.entry-card').scrollIntoView({block:'center'})`);
  await sleep(400);
  await snap('player-1-join');
  await js(`document.querySelector('.join-button').click()`);
  await waitFor(`!!document.querySelector('.player-ticket')`, 'the waiting card');
  await sleep(600);
  await js(`document.querySelector('.entry-card').scrollIntoView({block:'center'})`);
  await sleep(400);
  await snap('player-2-waiting');
  log('JOINED. You can press Enter in the seeder terminal now.');

  // 2. wait for the host to start, then play
  await waitFor(`!!document.querySelector('.answer-button')`, 'the quiz to start');
  await sleep(800);
  await js(`window.scrollTo(0,0)`);
  await snap('player-3-question');
  let n = 0;
  while (!(await js(`!!document.querySelector('.result-layout')`))) {
    const done = await js(`(()=>{const b=document.querySelector('.answer-button:not([disabled])'); if(!b) return false; b.click(); return true;})()`);
    if (done) {
      n++;
      if (n === 1) { await sleep(250); await snap('player-4-locked'); }
    }
    await sleep(750);
  }
  log(`answered ${n} questions`);

  // 3. result screen (full height)
  await sleep(1500);
  const height = await js('document.documentElement.scrollHeight');
  await view(Math.min(Math.max(812, height), 2200));
  await js(`window.scrollTo(0,0)`);
  await sleep(800);
  await snap('player-5-result');
  ws.close();
} finally {
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
