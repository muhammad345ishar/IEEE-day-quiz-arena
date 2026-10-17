import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import qrcode from 'qrcode-terminal';
import { createArena } from './app.js';
import { loadConfig } from './config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let arena;
try {
  if (!existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('Frontend not built. Run npm run build before npm start.');
  const config = loadConfig(root);
  arena = await createArena(config);
  const { url, port } = await arena.listen(config.port, '0.0.0.0');
  console.log(`\nIEEE Day Quiz Arena · PIEAS\n${arena.game.questions.length} questions loaded from questions.json\n`);
  console.log(`Players:     ${url}\nAdmin:       http://localhost:${port}/admin\nLeaderboard: ${url}/leaderboard\n`);
  qrcode.generate(url, { small: true });
  console.log(`\nListening on 0.0.0.0:${port}. Keep this terminal open.\n`);
  if (config.lanHost === '127.0.0.1') console.warn('No LAN adapter found. Connect to Wi-Fi/Ethernet and restart, or set LAN_HOST in .env.');
  if (['running', 'finished'].includes(arena.game.phase)) console.log(`Restored ${arena.game.phase} game with ${arena.game.activePlayers().length} players.`);
  const shutdown = async () => {
    console.log('\nSaving the game and shutting down…');
    try { await arena.close(); process.exit(0); } catch (error) { console.error(error.message); process.exit(1); }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error(`\nCannot start Quiz Arena: ${error.message}`);
  if (error.code === 'EADDRINUSE') console.error('Choose a free PORT in .env and run npm start again.');
  if (arena) await arena.close();
  process.exitCode = 1;
}
