#!/usr/bin/env node
// Demo seeder: fills a SEPARATE demo instance of the arena with fake players
// so you can take screenshots without a real crowd.
//
//   Terminal 1:  DATA_DIR=.demo-data PORT=3001 npm start
//   Terminal 2:  node scripts/demo-seed.js            (add --auto to skip the pauses)
//
// It reads ADMIN_USER / ADMIN_PASS from .env and never prints them.
// It refuses to run against port 3000 (the real event server).
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const base = flag('base', 'http://localhost:3001').replace(/\/$/, '');
const auto = args.includes('--auto');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (new URL(base).port === '3000') {
  console.error('Refusing to seed port 3000 (the real event server). Use a demo instance on port 3001.');
  process.exit(1);
}

function readEnv() {
  const out = {};
  for (const line of readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

class Client {
  constructor() { this.cookies = new Map(); }
  async call(method, route, body) {
    const res = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${data.error ?? ''}`);
    return data;
  }
}

// [name, chance of a correct answer, typical ms per question, stop after N answers (optional)]
const CAST = [
  ['Tony Stark', 0.95, 700],
  ['Ada Lovelace', 0.9, 900],
  ['Pied Piper', 0.85, 1100],
  ['Alan Turing', 0.85, 1500],
  ['Hedy Lamarr', 0.8, 1000],
  ['Grace Hopper', 0.75, 1300],
  ['Nikola Tesla', 0.7, 800],
  ['Alex', 0.65, 1700],
  ['Alex', 0.55, 1200],
  ['Margaret Hamilton', 0.5, 1900, 7],
  ['Sheldon Cooper', 0.9, 2400, 6],
  ['Dr. Strange', 0.4, 900, 4],
];

const questions = JSON.parse(readFileSync(path.join(root, 'questions.json'), 'utf8'));
const rl = auto ? null : createInterface({ input: process.stdin, output: process.stdout });
const pause = async message => {
  console.log(`\n>>> ${message}`);
  if (auto) await sleep(1500); else await rl.question('    Press Enter to continue... ');
};

const { ADMIN_USER, ADMIN_PASS } = readEnv();
const admin = new Client();
await admin.call('POST', '/api/admin/login', { username: ADMIN_USER, password: ADMIN_PASS });

let { state } = await admin.call('GET', '/api/admin/state');
if (state.phase !== 'closed') {
  console.log(`Demo game was "${state.phase}" - resetting it first.`);
  ({ state } = await admin.call('POST', '/api/admin/control', { action: 'reset' }));
}
await admin.call('POST', '/api/admin/control', { action: 'open' });

const players = [];
for (const [name, skill, pace, stopAfter] of CAST) {
  const client = new Client();
  const joined = await client.call('POST', '/api/player/join', { name });
  players.push({ client, name, skill, pace, stopAfter, id: joined.player.id, gameId: joined.state.gameId });
  console.log(`joined ${joined.player.id}  ${name}`);
}

await pause('LOBBY READY. Take the lobby/QR shot at /leaderboard and the admin shot at /admin.');

await admin.call('POST', '/api/admin/control', { action: 'start' });
console.log('Quiz started...');
await Promise.all(players.map(async p => {
  const limit = p.stopAfter ?? questions.length;
  for (let q = 0; q < limit; q++) {
    await sleep(p.pace * (0.6 + Math.random() * 0.8));
    const right = questions[q].correctIndex;
    const wrong = [0, 1, 2, 3].filter(i => i !== right);
    const optionIndex = Math.random() < p.skill ? right : wrong[Math.floor(Math.random() * 3)];
    await p.client.call('POST', '/api/player/answer', { gameId: p.gameId, questionIndex: q, optionIndex });
  }
}));

await pause('QUIZ IN PROGRESS (three players are still mid-quiz). Take the live top-ten shot and the admin progress shot now.');

await admin.call('POST', '/api/admin/control', { action: 'end' });
const final = await admin.call('GET', '/api/admin/state');
console.log('\nFinal standings:');
for (const p of final.players) console.log(`#${p.rank}  ${p.id}  ${p.name.padEnd(18)} ${p.correct}/${questions.length}  ${(p.totalTimeMs / 1000).toFixed(1)}s`);
console.log('\nQuiz ended. Take the podium shot at /leaderboard and the result screen on a phone-sized window.');
console.log('Clean up when finished: stop the demo server (Ctrl+C), then run: rm -rf .demo-data');
rl?.close();
