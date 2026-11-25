import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('../', import.meta.url));
const readConfig = [
  '--input-type=module', '--eval',
  `import { config } from './src/config/env.js';
   if (config.jwtSecret !== process.env.JWT_SECRET) process.exit(2);
   process.stdout.write(config.host);`,
];

function run(t, args, overrides = {}, dotenv = null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sms-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dotenvPath = path.join(dir, '.env');
  if (dotenv !== null) writeFileSync(dotenvPath, dotenv);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(JWT_SECRET|HOST|NODE_ENV|PORT|DOTENV_CONFIG_.*)$/i.test(name)));
  return spawnSync(process.execPath, args, {
    cwd: backend,
    env: { ...env, DOTENV_CONFIG_PATH: dotenvPath, ...overrides },
    encoding: 'utf8',
    timeout: 5000,
  });
}

test('server startup rejects a missing JWT secret in every environment', (t) => {
  for (const nodeEnv of [undefined, 'production', 'test']) {
    const env = nodeEnv ? { NODE_ENV: nodeEnv } : {};
    const result = run(t, ['src/server.js'], env);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /JWT_SECRET must be set/);
  }
});

test('rejects empty, whitespace-only, placeholder, and predictable secrets without logging their values', (t) => {
  for (const [label, secret] of [
    ['empty', ''],
    ['whitespace', ' '.repeat(40)],
    ['short', 'too-short'],
    ['original placeholder', 'CHANGE_ME'],
    ['long placeholder', 'Replace-with-your-own-random-JWT-secret'],
    ['repeated characters', 'a'.repeat(32)],
    ['known numeric sequence', '01234567890123456789012345678901'],
  ]) {
    const result = run(t, readConfig, {}, `JWT_SECRET="${secret}"\n`);
    assert.ifError(result.error);
    assert.equal(result.status, 1, label);
    assert.match(result.stderr, /JWT_SECRET must be set/, label);
    if (secret.trim()) assert.equal(result.stderr.includes(secret), false, label);
    assert.equal(result.stdout, '', label);
  }
});

test('loads a valid dotenv secret and defaults to loopback', (t) => {
  const secret = randomBytes(32).toString('hex');
  const result = run(t, readConfig, {}, `JWT_SECRET=${secret}\n`);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '127.0.0.1');
  assert.equal(result.stderr, '');
});

test('honors an explicit external host and treats a blank host as loopback', (t) => {
  const secret = randomBytes(32).toString('hex');
  for (const [host, expected] of [['0.0.0.0', '0.0.0.0'], ['::', '::'], ['  ', '127.0.0.1']]) {
    const result = run(t, readConfig, { JWT_SECRET: secret, NODE_ENV: 'production', HOST: host });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
});
