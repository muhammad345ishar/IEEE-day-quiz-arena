import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, appendFileSync, chmodSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';

export function loadConfig(root, logger = console.log) {
  const envPath = path.join(root, '.env');
  const file = existsSync(envPath) ? parse(readFileSync(envPath)) : {};
  const generated = [];
  if (!file.ADMIN_USER) { file.ADMIN_USER = `admin-${randomBytes(3).toString('hex')}`; generated.push('ADMIN_USER'); }
  if (!file.ADMIN_PASS) { file.ADMIN_PASS = randomBytes(18).toString('base64url'); generated.push('ADMIN_PASS'); }
  if (generated.length) {
    appendFileSync(envPath, '\n' + generated.map(key => `${key}=${file[key]}`).join('\n') + '\n', { mode: 0o600 });
    logger('Created missing admin credentials and saved them to .env:');
    for (const key of generated) logger(`${key}=${file[key]}`);
    logger('Keep .env private. These credentials are printed only when generated.');
  }
  chmodSync(envPath, 0o600);
  const port = Number(process.env.PORT ?? file.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const interfaces = Object.entries(networkInterfaces()).flatMap(([name, addresses]) => addresses.map(address => ({ ...address, name })))
    .filter(address => address.family === 'IPv4' && !address.internal)
    .sort((a, b) => Number(/^(en|eth|wlan|wi-fi)/i.test(b.name)) - Number(/^(en|eth|wlan|wi-fi)/i.test(a.name)));
  const lanHost = process.env.LAN_HOST ?? file.LAN_HOST ?? interfaces[0]?.address ?? '127.0.0.1';
  if (!/^[a-zA-Z0-9.-]+$/.test(lanHost)) throw new Error('LAN_HOST must be an IP address or hostname, without http:// or a port.');
  return { credentials: { username: file.ADMIN_USER, password: file.ADMIN_PASS }, port, lanHost,
    dataDir: path.resolve(root, process.env.DATA_DIR ?? file.DATA_DIR ?? '.data'), questionsPath: path.join(root, 'questions.json') };
}
