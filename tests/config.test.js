import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { loadConfig } from '../server/config.js';

// Credentials in these tests live only in disposable directories. Capture the
// startup logger so generated values never reach the host's terminal or TAP.
async function fixture(t, initialFile) {
  const directory = await mkdtemp(join(tmpdir(), 'quiz-arena-config-'));
  const envPath = join(directory, '.env');
  const savedEnvironment = new Map(['PORT', 'LAN_HOST', 'DATA_DIR'].map(key => [key, process.env[key]]));
  for (const key of savedEnvironment.keys()) delete process.env[key];
  t.after(async () => {
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  if (initialFile !== undefined) await writeFile(envPath, initialFile, { mode: 0o644 });
  const logs = [];
  return {
    directory, envPath, logs,
    load() { return loadConfig(directory, message => logs.push(message)); },
    async contents() { return readFile(envPath, 'utf8'); },
    async fields() { return parse(await readFile(envPath)); },
  };
}

test('first run creates private .env credentials once and subsequent runs do not print or rotate them', async t => {
  const f = await fixture(t);
  const initial = f.load();
  const file = await f.contents();
  const fields = await f.fields();
  assert.ok(/^admin-[a-f0-9]{6}$/.test(initial.credentials.username), 'Generated user has the documented short random suffix.');
  assert.ok(initial.credentials.password.length >= 24, 'Generated password has at least 24 characters.');
  assert.ok(initial.credentials.username === fields.ADMIN_USER, 'Generated user is saved for the next run.');
  assert.ok(initial.credentials.password === fields.ADMIN_PASS, 'Generated password is saved for the next run.');
  assert.equal(f.logs.filter(line => line.startsWith('ADMIN_USER=')).length, 1);
  assert.equal(f.logs.filter(line => line.startsWith('ADMIN_PASS=')).length, 1);
  assert.equal((await stat(f.envPath)).mode & 0o777, 0o600);
  f.logs.length = 0;
  const repeated = f.load();
  assert.ok(repeated.credentials.username === initial.credentials.username, 'Reload keeps the generated user.');
  assert.ok(repeated.credentials.password === initial.credentials.password, 'Reload keeps the generated password.');
  assert.ok((await f.contents()) === file, 'Reload does not append or modify credentials.');
  assert.equal(f.logs.length, 0, 'Existing credentials are never printed on restart.');
});

test('existing credentials and unrelated .env content are preserved and file permissions are tightened', async t => {
  const original = '# Event settings\nADMIN_USER="existing event admin"\nADMIN_PASS="config-test-password-only"\nPORT=4321\nCUSTOM_SETTING=keep-me\n';
  const f = await fixture(t, original);
  const config = f.load();
  assert.equal(config.credentials.username, 'existing event admin');
  assert.ok(config.credentials.password === 'config-test-password-only', 'Existing password remains unchanged.');
  assert.equal(config.port, 4321);
  assert.ok((await f.contents()) === original, 'Loading leaves comments and unrelated settings byte-for-byte unchanged.');
  assert.equal((await stat(f.envPath)).mode & 0o777, 0o600);
  assert.equal(f.logs.length, 0, 'Loading existing credentials does not log them.');
});

test('a missing password is generated without replacing or reprinting the existing username', async t => {
  const f = await fixture(t, 'ADMIN_USER=retained-admin\nLAN_HOST=quiz.local\n');
  const config = f.load();
  const fields = await f.fields();
  assert.equal(config.credentials.username, 'retained-admin');
  assert.equal(config.lanHost, 'quiz.local');
  assert.ok(config.credentials.password === fields.ADMIN_PASS, 'Generated password matches the saved field.');
  assert.ok(config.credentials.password.length >= 24);
  assert.equal(f.logs.filter(line => line.startsWith('ADMIN_USER=')).length, 0);
  assert.equal(f.logs.filter(line => line.startsWith('ADMIN_PASS=')).length, 1);
  assert.equal(fields.ADMIN_USER, 'retained-admin');
  assert.equal((await stat(f.envPath)).mode & 0o777, 0o600);
});

test('a missing username is generated without replacing or reprinting the existing password', async t => {
  const f = await fixture(t, 'ADMIN_PASS=config-test-retained-password\n');
  const config = f.load();
  const fields = await f.fields();
  assert.ok(/^admin-[a-f0-9]{6}$/.test(config.credentials.username));
  assert.ok(config.credentials.username === fields.ADMIN_USER, 'Generated username matches the saved field.');
  assert.ok(config.credentials.password === 'config-test-retained-password', 'Existing password is retained.');
  assert.equal(f.logs.filter(line => line.startsWith('ADMIN_USER=')).length, 1);
  assert.equal(f.logs.filter(line => line.startsWith('ADMIN_PASS=')).length, 0);
  assert.ok(f.logs.every(line => !line.includes('config-test-retained-password')), 'The retained password is absent from log messages.');
});

test('invalid .env ports stop startup with a clear actionable error', async t => {
  const f = await fixture(t);
  for (const value of ['0', '-1', '65536', '1.5', 'abc', '']) {
    await writeFile(f.envPath, `ADMIN_USER=test-admin\nADMIN_PASS=config-test-only\nPORT=${value}\n`);
    assert.throws(() => f.load(), /PORT must be an integer from 1 to 65535\./, `PORT=${value} must be rejected.`);
  }
  assert.equal(f.logs.length, 0);
});

test('environment port overrides .env, is validated, and supported boundary ports work', async t => {
  const f = await fixture(t, 'ADMIN_USER=test-admin\nADMIN_PASS=config-test-only\nPORT=4321\n');
  process.env.PORT = '5432';
  assert.equal(f.load().port, 5432);
  for (const value of ['1', '65535']) {
    process.env.PORT = value;
    assert.equal(f.load().port, Number(value));
  }
  process.env.PORT = 'not-a-port';
  assert.throws(() => f.load(), /PORT must be an integer from 1 to 65535\./);
  assert.equal(f.logs.length, 0);
});
