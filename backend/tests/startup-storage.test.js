import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareUploadRoot, requireControlledDirectory, resolveAndroidUploadPath } from '../src/config/upload-root.js';
import { openDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrate.js';
import { openDocumentFile, storeDocumentFile } from '../src/modules/documents/documents.storage.js';
import { pdf } from './document-fixtures.js';
import { newId } from '../src/utils/ids.js';

const backend = fileURLToPath(new URL('../', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'sms-startup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runServer(dir, uploadDir, databasePath) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(HOST|PORT|DATABASE_PATH|UPLOAD_DIR|JWT_SECRET|NODE_ENV|LOG_LEVEL|DOTENV_CONFIG_.*)$/i.test(name)));
  return spawnSync(process.execPath, ['src/server.js'], {
    cwd: backend,
    env: {
      ...env,
      DOTENV_CONFIG_PATH: path.join(dir, '.no-env'),
      NODE_ENV: 'production',
      JWT_SECRET: randomBytes(32).toString('hex'),
      LOG_LEVEL: 'info',
      UPLOAD_DIR: uploadDir,
      DATABASE_PATH: databasePath,
    },
    encoding: 'utf8',
    timeout: 5000,
  });
}

function assertStartupFailure(result, message) {
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, message);
  assert.doesNotMatch(result.stdout + result.stderr, /Server listening/);
}

test('storage initialization creates a dedicated root, cleans its probe, and rejects later replacement', (t) => {
  const dir = fixture(t);
  const parent = path.join(dir, 'private');
  const destination = path.join(parent, 'uploads');
  const moved = path.join(dir, 'moved');
  const prepared = prepareUploadRoot(destination);
  assert.equal(prepared.getPath(), destination);
  assert.deepEqual(readdirSync(destination), []);
  renameSync(parent, moved);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  assert.throws(() => prepared.getPath(), /changed after startup/);
});

test('startup rejects a symlink at the storage root or its parent before reconciliation or database creation', (t) => {
  const dir = fixture(t);
  const target = path.join(dir, 'real');
  const linked = path.join(dir, 'linked');
  const database = path.join(dir, 'db.sqlite');
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  for (const root of [linked, path.join(linked, 'uploads')]) {
    assertStartupFailure(runServer(dir, root, database), /not a real directory/);
  }
  assert.equal(existsSync(database), false);
  assert.deepEqual(readdirSync(target), []);
});

test('POSIX initialization rejects an upload root with public permissions and an unsafe writable parent', {
  skip: process.platform === 'win32' ? 'POSIX ownership and mode checks require a POSIX runner' : false,
}, (t) => {
  const dir = fixture(t);
  const parent = path.join(dir, 'private');
  const destination = path.join(parent, 'uploads');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  chmodSync(destination, 0o755);
  assert.throws(() => prepareUploadRoot(destination), /unsafe ownership or permissions/);
  chmodSync(destination, 0o700);
  chmodSync(parent, 0o777);
  assert.throws(() => prepareUploadRoot(destination), /ancestor is writable/);
  chmodSync(parent, 0o700);
  assert.equal(prepareUploadRoot(destination).getPath(), destination);
});

test('Android policy permits the app-owned 0771 wrapper and rejects unsafe paths and modes', () => {
  const appData = '/data/data/com.termux';
  const canonical = '/data/user/0/com.termux';
  assert.deepEqual(resolveAndroidUploadPath(`${appData}/files/home/uploads`, () => canonical), {
    base: canonical, root: `${canonical}/files/home/uploads`,
  });
  for (const candidate of ['/sdcard/uploads', '/data/data/com.termux.fake/uploads', '/data/local/tmp/uploads']) {
    assert.throws(() => resolveAndroidUploadPath(candidate, () => canonical), /private Android/);
  }
  assert.throws(() => resolveAndroidUploadPath(`${appData}/uploads`, () => '/sdcard'), /private Android/);
  const owner = 10123;
  const wrapper = { isDirectory: () => true, uid: owner, gid: owner, mode: 0o771 };
  const policy = { androidPrivate: true, androidFiles: true, owner };
  assert.doesNotThrow(() => requireControlledDirectory('files', wrapper, policy));
  assert.throws(() => requireControlledDirectory('files', { ...wrapper, gid: 0 }, policy), /writable/);
  assert.throws(() => requireControlledDirectory('files', { ...wrapper, uid: 0 }, policy), /ownership/);
  assert.throws(() => requireControlledDirectory('files', { ...wrapper, mode: 0o777 }, policy), /writable/);
  assert.throws(() => requireControlledDirectory('home', wrapper, { ...policy, androidFiles: false }), /writable/);
  assert.throws(() => requireControlledDirectory('uploads', wrapper, { ...policy, isRoot: true }), /permissions/);
});

test('upload allocation retries database, legacy file and reserved-directory UUID collisions', async (t) => {
  const dir = fixture(t);
  const root = prepareUploadRoot(path.join(dir, 'uploads'));
  const [rowKey, legacyKey, occupiedKey, availableKey] = Array.from({ length: 4 }, newId);
  const legacy = path.join(root.getPath(), legacyKey);
  const occupied = path.join(root.getPath(), `.${occupiedKey}.document`);
  writeFileSync(legacy, 'existing flat file');
  mkdirSync(occupied);
  writeFileSync(path.join(occupied, 'content'), 'existing payload');
  const keys = [rowKey, legacyKey, occupiedKey, availableKey];
  const actual = await storeDocumentFile(root, Readable.from([pdf]), 'valid.pdf', ({ storageKey }) => storageKey, {
    getStorageKey: () => keys.shift(),
    isReferenced: (key) => key === rowKey,
  });
  assert.equal(actual, availableKey);
  assert.equal(readFileSync(legacy, 'utf8'), 'existing flat file');
  assert.equal(readFileSync(path.join(occupied, 'content'), 'utf8'), 'existing payload');
});
test('document operations use the pinned root and reject a replacement directory', async (t) => {
  const dir = fixture(t);
  const uploadDir = path.join(dir, 'uploads');
  const root = prepareUploadRoot(uploadDir);
  const key = await storeDocumentFile(root, Readable.from([pdf]), 'valid.pdf', ({ storageKey }) => storageKey);
  const { stream } = await openDocumentFile(root, key);
  const data = [];
  for await (const chunk of stream) data.push(chunk);
  assert.deepEqual(Buffer.concat(data), pdf);
  renameSync(uploadDir, path.join(dir, 'old-uploads'));
  mkdirSync(uploadDir, { mode: 0o700 });
  await assert.rejects(openDocumentFile(root, key), /changed after startup/);
  await assert.rejects(storeDocumentFile(root, Readable.from([pdf]), 'blocked.pdf', () => {
    assert.fail('Replacement directory must never be used to publish');
  }), /changed after startup/);
  assert.deepEqual(readdirSync(uploadDir), []);
});

test('storage starts, uploads, reads and deletes with hard-link operations denied', (t) => {
  const dir = fixture(t);
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { Readable } from 'node:stream';
    const deny = () => { throw Object.assign(new Error('Hard links unavailable'), { code: 'EACCES' }); };
    fs.link = fs.linkSync = fs.promises.link = deny;
    syncBuiltinESMExports();
    const { prepareUploadRoot } = await import('./src/config/upload-root.js');
    const { storeDocumentFile, openDocumentFile, prepareDocumentDeletion } =
      await import('./src/modules/documents/documents.storage.js');
    const { pdf } = await import('./tests/document-fixtures.js');
    const root = prepareUploadRoot(process.argv[1]);
    const key = await storeDocumentFile(root, Readable.from([pdf]), 'valid.pdf', ({ storageKey }) => storageKey);
    const { stream } = await openDocumentFile(root, key);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), pdf);
    prepareDocumentDeletion(root, key)(true);
    assert.deepEqual(fs.readdirSync(root.getPath()), []);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script, path.join(dir, 'uploads')], {
    cwd: backend, encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
test('startup refuses a database stored under the upload root', (t) => {
  const dir = fixture(t);
  const uploadDir = path.join(dir, 'uploads');
  const database = path.join(uploadDir, 'db.sqlite');
  assertStartupFailure(runServer(dir, uploadDir, database), /DATABASE_PATH must be outside UPLOAD_DIR/);
});

test('a reconciliation query failure aborts startup before listening or removing artifacts', (t) => {
  const dir = fixture(t);
  const database = path.join(dir, 'db.sqlite');
  const uploadDir = path.join(dir, 'uploads');
  const artifact = '.11111111-1111-1111-1111-111111111111.part';
  mkdirSync(uploadDir, { mode: 0o700 });
  writeFileSync(path.join(uploadDir, artifact), 'staging');
  const db = openDatabase(database);
  runMigrations(db);
  db.exec('DROP TABLE documents');
  db.close();
  assertStartupFailure(runServer(dir, uploadDir, database), /no such table: documents/);
  assert.deepEqual(readdirSync(uploadDir), [artifact]);
});
