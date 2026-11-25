import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrate.js';
import { reconcileDocuments } from '../src/modules/documents/documents.service.js';
import { prepareDocumentDeletion } from '../src/modules/documents/documents.storage.js';
import { MAX_DOCUMENT_BYTES } from '../src/modules/documents/documents.storage.js';
import { newId } from '../src/utils/ids.js';
import { archive, docxParts, pdf, pdfChunks } from './document-fixtures.js';

const boundary = 'campusos-test-boundary';
const multipartHeaders = { 'content-type': `multipart/form-data; boundary=${boundary}` };
const end = `--${boundary}--\r\n`;
const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
const fileStart = (name) =>
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
const file = (name, body = pdf) => Buffer.concat([Buffer.from(fileStart(name)), body, Buffer.from('\r\n')]);

async function setup(t, config = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sms-p5-api-'));
  const uploadDir = path.join(dir, 'uploads');
  const db = openDatabase(':memory:');
  runMigrations(db);
  const app = buildApp({ db, config: { logLevel: 'silent', jwtSecret: 'phase5-test-secret', uploadDir, ...config } });
  t.after(async () => {
    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  await app.ready();
  const courseId = newId();
  const users = { teacher: 'teacher', other: 'teacher', student: 'student', outsider: 'student', admin: 'admin' };
  const insertUser = db.prepare('INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)');
  for (const [id, role] of Object.entries(users)) insertUser.run(id, id, `${id}@example.com`, 'unused', role);
  db.prepare('INSERT INTO courses VALUES (?, ?, ?, ?)').run(courseId, 'CS101', 'Course', 'teacher');
  db.prepare('INSERT INTO enrollments (course_id, student_id) VALUES (?, ?)').run(courseId, 'student');

  const auth = (id, claims) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role: users[id], ...claims })}` });
  function request(method, suffix, user, payload, headers = {}) {
    return app.inject({ method, url: `/api/documents${suffix}`, headers: { ...(user ? auth(user) : {}), ...headers }, payload });
  }
  const fields = field('courseId', courseId) + field('title', ' Handout ');
  const upload = (parts = [fields, file('notes.pdf'), end], user = 'teacher') =>
    request('POST', '', user, Buffer.concat(parts.map((part) => Buffer.from(part))), multipartHeaders);
  const count = () => db.prepare('SELECT COUNT(*) FROM documents').pluck().get();
  const files = async () => {
    try {
      return await readdir(uploadDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  };
  return { app, auth, count, courseId, db, dir, fields, files, request, upload, uploadDir };
}

test('upload, list, edit, stream and delete through the API', async (t) => {
  const { courseId, fields, files, request, upload, count } = await setup(t);
  const created = await upload([file('Résumé.pdf'), fields, field('description', 'Original'), end]);
  assert.equal(created.statusCode, 201, created.body);
  const { data } = created.json();
  assert.equal(data.original_filename, 'Résumé.pdf');
  assert.equal(data.title, 'Handout');
  assert.equal(data.description, 'Original');
  assert.equal(data.file_size, pdf.length);
  assert.equal(Object.hasOwn(data, 'file_path'), false);
  const list = await request('GET', `?courseId=${courseId}`, 'student');
  assert.deepEqual(list.json().data, [data]);

  const updated = await request('PATCH', `/${data.id}`, 'admin', { title: ' Revised ', description: null });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(updated.json().data, { ...data, title: 'Revised', description: null });

  const download = await request('GET', `/${data.id}/download`, 'student');
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, pdf);
  assert.equal(download.headers['content-type'], 'application/pdf');
  assert.equal(download.headers['content-length'], String(pdf.length));
  assert.equal(download.headers['content-disposition'], 'attachment; filename="R_sum_.pdf"; filename*=UTF-8\'\'R%C3%A9sum%C3%A9.pdf');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.equal(download.headers['cache-control'], 'private, no-store');

  const removed = await request('DELETE', `/${data.id}`, 'teacher');
  assert.equal(removed.statusCode, 204);
  assert.equal(count(), 0);
  assert.deepEqual(await files(), []);
});

test('malformed and unsupported uploads leave no file or metadata', async (t) => {
  const { upload, fields, files, count, request } = await setup(t);
  for (const [label, parts, status] of [
    ['extension', [fields, file('notes.exe'), end], 415],
    ['signature', [fields, file('notes.jpg'), end], 415],
    ['filename', [fields, file('../notes.pdf'), end], 400],
    ['missing file', [fields, end], 400],
    ['missing fields', [file('notes.pdf'), end], 400],
    ['duplicate field', [fields, file('notes.pdf'), field('title', 'duplicate'), end], 400],
    ['second file', [fields, file('notes.pdf'), file('second.pdf'), end], 413],
    ['long field', [fields, file('notes.pdf'), field('description', 'x'.repeat(4_001)), end], 400],
    ['truncated body', [fields, file('notes.pdf')], 400],
  ]) {
    await t.test(label, { timeout: 5000 }, async () => {
      const response = await upload(parts);
      assert.equal(response.statusCode, status, response.body);
      assert.equal(count(), 0);
      assert.deepEqual(await files(), []);
    });
  }
  assert.equal((await request('POST', '', 'teacher', {})).statusCode, 415);
  assert.equal((await request('POST', '', 'teacher', Buffer.from('bad'), { 'content-type': 'multipart/form-data' })).statusCode, 400);
});

test('real HTTP uploads accept exactly 50 MiB and reject one byte over', async (t) => {
  const { app, auth, fields, files, count } = await setup(t);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  async function send(size) {
    const body = Readable.from((function* () {
      yield Buffer.from(fields + fileStart('large.pdf'));
      yield* pdfChunks(size);
      yield Buffer.from('\r\n' + end);
    })());
    const response = await fetch(`${url}/api/documents`, {
      method: 'POST', headers: { ...auth('teacher'), ...multipartHeaders }, body, duplex: 'half',
    });
    return { status: response.status, body: await response.json() };
  }
  const accepted = await send(MAX_DOCUMENT_BYTES);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.file_size, MAX_DOCUMENT_BYTES);
  const rejected = await send(MAX_DOCUMENT_BYTES + 1);
  assert.equal(rejected.status, 413, JSON.stringify(rejected.body));
  assert.equal(count(), 1);
  assert.equal((await files()).length, 1);
});

test('disconnect during an HTTP upload removes the staging file', async (t) => {
  const { app, auth, fields, files, count } = await setup(t);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = httpRequest(`${url}/api/documents`, {
    method: 'POST', headers: { ...auth('teacher'), ...multipartHeaders },
  });
  client.on('error', () => {});
  async function waitForFiles(expected) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await files()).length === expected) return;
      await delay(20);
    }
    assert.equal((await files()).length, expected);
  }
  try {
    client.write(fields + fileStart('partial.pdf'));
    client.write(pdf);
    client.write(Buffer.alloc(64 * 1024));
    await waitForFiles(1);
  } finally {
    client.destroy();
  }
  await waitForFiles(0);
  assert.equal(count(), 0);
});

function pendingUpload(url, authHeaders, initialBody) {
  const client = httpRequest(`${url}/api/documents`, {
    method: 'POST', headers: { ...authHeaders, ...multipartHeaders },
  });
  const response = new Promise((resolve) => {
    client.once('error', resolve);
    client.once('response', (reply) => {
      const chunks = [];
      reply.on('data', (chunk) => chunks.push(chunk));
      reply.on('end', () => resolve({ status: reply.statusCode, body: Buffer.concat(chunks).toString() }));
      reply.on('error', resolve);
    });
  });
  if (initialBody) client.write(initialBody);
  else client.flushHeaders();
  return { client, response };
}

async function waitForStaging(files, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await files()).filter((fileName) => fileName.endsWith('.document')).length === count) return;
    await delay(20);
  }
  assert.fail(`Expected ${count} staging files`);
}

test('two active uploads fill the default limit, then disconnects release their slots', { timeout: 10_000 }, async (t) => {
  const { app, auth, upload, fields, files, count } = await setup(t);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const body = fields + fileStart('partial.pdf') + pdf + 'x'.repeat(1024);
  const first = pendingUpload(url, auth('teacher'), body);
  const second = pendingUpload(url, auth('teacher'), body);
  try {
    await waitForStaging(files, 2);
    assert.equal((await upload(undefined, 'student')).statusCode, 403);
    const busy = await upload();
    assert.equal(busy.statusCode, 429, busy.body);
    assert.equal(busy.headers['retry-after'], '1');
    assert.equal((await files()).length, 2);
    assert.equal(count(), 0);
  } finally {
    first.client.destroy();
    second.client.destroy();
  }
  await waitForStaging(files, 0);
  assert.equal((await upload()).statusCode, 201);
});

test('timeouts cancel a pending parser and an active file stream, then release their slots', { timeout: 10_000 }, async (t) => {
  const { app, auth, upload, fields, files, count } = await setup(t, { documentUploadTimeoutMs: 750 });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const waitingForPart = pendingUpload(url, auth('teacher'), `--${boundary}\r\n`);
  const writing = pendingUpload(url, auth('teacher'), fields + fileStart('partial.pdf') + pdf + 'x'.repeat(1024));
  try {
    await waitForStaging(files, 1);
    const responses = await Promise.all([waitingForPart.response, writing.response]);
    for (const response of responses) {
      assert.equal(response.status, 408, response.body ?? String(response));
      assert.equal(JSON.parse(response.body).error.code, 'UPLOAD_TIMEOUT');
    }
    assert.deepEqual(await files(), []);
    assert.equal(count(), 0);
    assert.equal((await upload()).statusCode, 201);
  } finally {
    waitingForPart.client.destroy();
    writing.client.destroy();
  }
});

test('ZIP and DOCX accept 1,000 archive entries and reject 1,001 without leaving files', async (t) => {
  const { upload, fields, files, count } = await setup(t);
  for (const [filename, required] of [
    ['archive.zip', []],
    ['notes.docx', docxParts],
  ]) {
    const names = [...required, ...Array.from({ length: 1000 - required.length }, (_, i) => `entry-${i}`)];
    const accepted = await upload([fields, file(filename, archive(names)), end]);
    assert.equal(accepted.statusCode, 201, accepted.body);
    const rejected = await upload([fields, file(filename, archive([...names, 'over-limit'])), end]);
    assert.equal(rejected.statusCode, 413, rejected.body);
    assert.equal(rejected.json().error.code, 'ARCHIVE_ENTRY_LIMIT');
  }
  assert.equal(count(), 2);
  assert.equal((await files()).length, 2);
});

test('course rejection and a configured archive limit clean up and release the upload slot', async (t) => {
  const { fields, files, count, upload } = await setup(t, {
    documentUploadConcurrency: 1,
    documentArchiveMaxEntries: 1,
  });
  assert.equal((await upload(undefined, 'other')).statusCode, 403);
  assert.deepEqual(await files(), []);
  assert.equal((await upload([file('notes.pdf'), fields, end], 'other')).statusCode, 403);
  assert.deepEqual(await files(), []);
  const rejected = await upload([fields, file('archive.zip', archive(['one', 'two'])), end]);
  assert.equal(rejected.statusCode, 413, rejected.body);
  assert.equal(count(), 0);
  assert.deepEqual(await files(), []);
  assert.equal((await upload()).statusCode, 201);
});

test('document listing paginates in stable order with default, maximum, final and empty pages', async (t) => {
  const { courseId, db, request } = await setup(t);
  const list = (params = '') => request('GET', `?courseId=${courseId}${params}`, 'student');
  const empty = await list();
  assert.deepEqual(empty.json().data, []);
  assert.equal(empty.headers['x-next-page'], undefined);
  const ids = Array.from({ length: 103 }, () => newId()).sort();
  const insert = db.prepare(`INSERT INTO documents
    (id, course_id, uploaded_by, title, file_path, file_size, mime_type, uploaded_at)
    VALUES (?, ?, 'teacher', 'Page fixture', ?, 1, 'application/pdf', '2026-01-01')`);
  db.transaction(() => {
    for (const id of [...ids].reverse()) insert.run(id, courseId, id);
  })();
  const first = await list();
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().data.map(({ id }) => id), ids.slice(0, 50));
  assert.equal(first.headers['x-next-page'], '2');
  const max = await list('&limit=100');
  assert.deepEqual(max.json().data.map(({ id }) => id), ids.slice(0, 100));
  assert.equal(max.headers['x-next-page'], '2');
  const final = await list('&page=2&limit=100');
  assert.deepEqual(final.json().data.map(({ id }) => id), ids.slice(100));
  assert.equal(final.headers['x-next-page'], undefined);
  const beyond = await list('&page=3&limit=100');
  assert.deepEqual(beyond.json().data, []);
  assert.equal(beyond.headers['x-next-page'], undefined);
  for (const params of ['&limit=101', '&limit=0', '&page=0', '&page=1.5']) {
    assert.equal((await list(params)).statusCode, 400);
  }
});

test('authentication, staff RBAC, ownership and current enrollment gate each operation', async (t) => {
  const { auth, courseId, db, request, upload } = await setup(t);
  const created = await upload(undefined, 'admin');
  assert.equal(created.statusCode, 201, created.body);
  const { id } = created.json().data;
  const routes = [
    ['POST', ''], ['GET', `?courseId=${courseId}`], ['PATCH', `/${id}`],
    ['DELETE', `/${id}`], ['GET', `/${id}/download`],
  ];
  for (const [method, suffix] of routes) {
    assert.equal((await request(method, suffix)).statusCode, 401);
  }
  const expired = auth('student', { iat: Math.floor(Date.now() / 1000) - 86_400 });
  assert.equal((await request('GET', `?courseId=${courseId}`, null, undefined, expired)).statusCode, 401);
  for (const user of ['student', 'other']) {
    assert.equal((await upload(undefined, user)).statusCode, 403);
    assert.equal((await request('PATCH', `/${id}`, user, { title: 'No' })).statusCode, 403);
    assert.equal((await request('DELETE', `/${id}`, user)).statusCode, 403);
  }
  for (const user of ['outsider', 'other']) {
    assert.equal((await request('GET', `?courseId=${courseId}`, user)).statusCode, 403);
    assert.equal((await request('GET', `/${id}/download`, user)).statusCode, 403);
  }
  db.exec('DELETE FROM enrollments');
  assert.equal((await request('GET', `/${id}/download`, 'student')).statusCode, 403);
});

test('missing documents/files and unsafe paths receive controlled errors', async (t) => {
  const { db, dir, request, upload, uploadDir, count } = await setup(t);
  const created = await upload();
  const { id } = created.json().data;
  for (const [method, suffix] of [['GET', '/download'], ['PATCH', ''], ['DELETE', '']]) {
    const payload = method === 'PATCH' ? { title: 'Revised' } : undefined;
    assert.equal((await request(method, `/${newId()}${suffix}`, 'teacher', payload)).statusCode, 404);
  }
  assert.equal((await request('GET', '/%2e%2e%2fsecret/download', 'teacher')).statusCode, 400);
  assert.equal((await request('PATCH', `/${id}`, 'teacher', { file_path: 'private.pdf', title: 'No' })).statusCode, 400);
  const secret = path.join(dir, 'private.pdf');
  await writeFile(secret, pdf);
  const key = db.prepare('SELECT file_path FROM documents WHERE id = ?').pluck().get(id);
  const setPath = db.prepare('UPDATE documents SET file_path = ? WHERE id = ?');
  setPath.run('../private.pdf', id);
  assert.equal((await request('GET', `/${id}/download`, 'teacher')).statusCode, 404);
  assert.equal((await request('DELETE', `/${id}`, 'teacher')).statusCode, 404);
  setPath.run(key, id);
  await unlink(path.join(uploadDir, `.${key}.document`, 'content'));
  assert.equal((await request('GET', `/${id}/download`, 'teacher')).statusCode, 404);
  assert.equal((await request('DELETE', `/${id}`, 'teacher')).statusCode, 204);
  assert.equal(count(), 0);
});

test('overlapping deletes for the same document return one success and one 404', async (t) => {
  const { count, files, request, upload } = await setup(t);
  const { data } = (await upload()).json();
  const results = await Promise.all([
    request('DELETE', `/${data.id}`, 'teacher'),
    request('DELETE', `/${data.id}`, 'teacher'),
  ]);
  assert.deepEqual(results.map(({ statusCode }) => statusCode).sort(), [204, 404]);
  assert.equal(count(), 0);
  assert.deepEqual(await files(), []);
});

test('failed document inserts and deletes preserve consistency and hide internal errors', async (t) => {
  const { count, db, files, request, upload, uploadDir } = await setup(t);
  db.exec(`CREATE TRIGGER reject_upload BEFORE INSERT ON documents
           BEGIN SELECT RAISE(ABORT, 'private-insert-error'); END`);
  const failedUpload = await upload();
  assert.equal(failedUpload.statusCode, 500);
  assert.doesNotMatch(failedUpload.body, /private-insert-error/);
  assert.equal(count(), 0);
  assert.deepEqual(await files(), []);
  db.exec('DROP TRIGGER reject_upload');
  const { data } = (await upload()).json();
  const originalFiles = await files();
  const [reservation] = originalFiles;
  let bytesStayedInPlace = false;
  db.function('inspect_payload', () => {
    bytesStayedInPlace = existsSync(path.join(uploadDir, reservation, 'content'));
    return null;
  });
  db.exec(`CREATE TRIGGER reject_delete BEFORE DELETE ON documents
           BEGIN SELECT inspect_payload(); SELECT RAISE(ABORT, 'private-delete-error'); END`);
  const failedDelete = await request('DELETE', `/${data.id}`, 'teacher');
  assert.equal(failedDelete.statusCode, 500);
  assert.equal(bytesStayedInPlace, true);
  assert.doesNotMatch(failedDelete.body, /private-delete-error/);
  assert.equal(count(), 1);
  assert.deepEqual(await files(), originalFiles);
  const download = await request('GET', `/${data.id}/download`, 'teacher');
  assert.deepEqual(download.rawPayload, pdf);
});

test('startup reconciliation preserves live files and cleans identifiable interrupted operations repeatedly', async (t) => {
  const { db, files, request, upload, uploadDir } = await setup(t);
  const { data: live } = (await upload()).json();
  const { data: committed } = (await upload()).json();
  const { data: legacy } = (await upload()).json();
  const { data: replaced } = (await upload()).json();
  const storageKey = db.prepare('SELECT file_path FROM documents WHERE id = ?').pluck();
  const liveKey = storageKey.get(live.id);
  const committedKey = storageKey.get(committed.id);
  const legacyKey = storageKey.get(legacy.id);
  const replacedKey = storageKey.get(replaced.id);
  const uncommitted = newId();
  const stageOnly = newId();
  const unknown = newId();
  const at = (name) => path.join(uploadDir, name);
  const reservation = (key) => at(`.${key}.document`);

  // A crash before DELETE commit leaves the live row and its bytes untouched.
  prepareDocumentDeletion(uploadDir, liveKey);
  // Crash after DELETE commit, before unlinking the content.
  db.prepare('DELETE FROM documents WHERE id = ?').run(committed.id);
  // Crash during upload and just after reserving a directory.
  await mkdir(reservation(uncommitted));
  await writeFile(path.join(reservation(uncommitted), 'v1'), '');
  await writeFile(path.join(reservation(uncommitted), 'content'), pdf.subarray(0, 8));
  await mkdir(reservation(stageOnly));
  // A previous-format flat file has a journal before SQLite changes.
  for (const key of [legacyKey, replacedKey]) {
    await rename(path.join(reservation(key), 'content'), at(key));
    await rm(reservation(key), { recursive: true });
    prepareDocumentDeletion(uploadDir, key);
  }
  db.prepare('DELETE FROM documents WHERE id = ?').run(replaced.id);
  await writeFile(at(replacedKey), 'replacement');
  const ambiguous = newId();
  await mkdir(reservation(ambiguous));
  await writeFile(path.join(reservation(ambiguous), 'content'), 'no marker');
  await writeFile(at(unknown), 'unknown');
  await writeFile(at(`.${unknown}.delete`), 'malformed');
  await writeFile(at(`.${unknown}.deleted`), 'legacy');

  await reconcileDocuments(db, uploadDir);
  await reconcileDocuments(db, uploadDir);
  assert.deepEqual(await files(), [`.${liveKey}.document`, legacyKey, replacedKey, `.${replacedKey}.delete`,
    `.${ambiguous}.document`, unknown, `.${unknown}.delete`, `.${unknown}.deleted`].sort());
  assert.equal(await readFile(at(unknown), 'utf8'), 'unknown');
  assert.equal(await readFile(at(replacedKey), 'utf8'), 'replacement');
  for (const id of [live.id, legacy.id]) {
    const response = await request('GET', `/${id}/download`, 'student');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, pdf);
  }
  assert.equal((await request('GET', `/${committed.id}/download`, 'student')).statusCode, 404);
  // An actual legacy deletion removes both the original bytes and the journal.
  assert.equal((await request('DELETE', `/${legacy.id}`, 'teacher')).statusCode, 204);
  assert.equal(existsSync(at(legacyKey)), false);
  assert.equal(existsSync(at(`.${legacyKey}.delete`)), false);
});
