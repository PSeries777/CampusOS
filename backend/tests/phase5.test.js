import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { openDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrate.js';
import { createDocument, listDocuments, readDocument } from '../src/modules/documents/documents.service.js';
import { MAX_DOCUMENT_BYTES } from '../src/modules/documents/documents.storage.js';
import { UUID_PATTERN } from '../src/utils/validation.js';
import { archive, docxParts, jpeg, pdf, pdfChunks, png } from './document-fixtures.js';

const teacher = { sub: 'teacher', role: 'teacher' };
const student = { sub: 'student', role: 'student' };
const zip = archive(['notes.txt'], { descriptor: true });
const docx = archive(docxParts);

async function setup(t, { legacy = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sms-p5-'));
  const db = openDatabase(':memory:');
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  if (legacy) {
    const migrations = path.join(dir, 'migrations');
    await mkdir(migrations);
    const name = '001_initial_schema.sql';
    await copyFile(new URL(`../src/database/migrations/${name}`, import.meta.url), path.join(migrations, name));
    runMigrations(db, migrations);
  } else {
    runMigrations(db);
  }
  db.exec(`
    INSERT INTO users (id, full_name, email, password_hash, role) VALUES
      ('teacher', 'Teacher', 'teacher@example.com', 'unused', 'teacher'),
      ('other', 'Other', 'other@example.com', 'unused', 'teacher'),
      ('student', 'Student', 'student@example.com', 'unused', 'student');
    INSERT INTO courses VALUES ('course', 'CS101', 'Course', 'teacher');
    INSERT INTO enrollments (course_id, student_id) VALUES ('course', 'student');
  `);
  const uploadDir = path.join(dir, 'uploads');
  await mkdir(uploadDir);
  const upload = (originalFilename, source, user = teacher) =>
    createDocument(db, uploadDir, user, { courseId: 'course', title: ' Handout ', originalFilename, source });
  const count = () => db.prepare('SELECT COUNT(*) FROM documents').pluck().get();
  return { dir, db, uploadDir, upload, count };
}

test('filename migration preserves existing document rows and is idempotent', async (t) => {
  const { db } = await setup(t, { legacy: true });
  db.exec(`INSERT INTO documents (id, course_id, uploaded_by, title, file_path, file_size, mime_type)
           VALUES ('old', 'course', 'teacher', 'Old handout', 'old.pdf', 10, 'application/pdf')`);
  const before = db.prepare('SELECT * FROM documents').get();
  assert.deepEqual(runMigrations(db), ['002_documents_original_filename.sql', '003_documents_pagination_index.sql']);
  assert.deepEqual(db.prepare('SELECT * FROM documents').get(), { ...before, original_filename: null });
  assert.deepEqual(runMigrations(db), []);
});

test('stores all five formats with private generated keys and streams bytes to an enrolled reader', async (t) => {
  const { db, uploadDir, upload } = await setup(t);
  const formats = [
    ['Résumé.PDF', pdf, 'application/pdf'],
    ['notes.docx', docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['figure.png', png, 'image/png'],
    ['photo.jpg', jpeg, 'image/jpeg'],
    ['photo.jpeg', jpeg, 'image/jpeg'],
    ['notes.zip', zip, 'application/zip'],
  ];
  for (const [filename, bytes, mime] of formats) {
    const metadata = await upload(filename, Readable.from([bytes]));
    assert.equal(metadata.original_filename, filename);
    assert.equal(metadata.title, 'Handout');
    assert.equal(metadata.uploaded_by, teacher.sub);
    assert.equal(metadata.file_size, bytes.length);
    assert.equal(metadata.mime_type, mime);
    assert.ok(metadata.uploaded_at);
    assert.equal(Object.hasOwn(metadata, 'file_path'), false);
    const key = db.prepare('SELECT file_path FROM documents WHERE id = ?').pluck().get(metadata.id);
    assert.match(key, new RegExp(UUID_PATTERN));
    assert.deepEqual(await readFile(path.join(uploadDir, `.${key}.document`, 'content')), bytes);
    const opened = await readDocument(db, uploadDir, student, metadata.id);
    assert.deepEqual(opened.metadata, metadata);
    assert.equal(opened.size, bytes.length);
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
  }
  assert.equal(listDocuments(db, student, 'course').length, formats.length);
  assert.equal((await readdir(uploadDir)).length, formats.length);
});

test('accepts exactly 50 MiB and cleans up oversized and upstream-truncated streams', async (t) => {
  const { upload, uploadDir, count } = await setup(t);
  assert.equal(MAX_DOCUMENT_BYTES, 52_428_800);
  const accepted = await upload('limit.pdf', Readable.from(pdfChunks(MAX_DOCUMENT_BYTES)));
  assert.equal(accepted.file_size, MAX_DOCUMENT_BYTES);
  await assert.rejects(upload('over.pdf', Readable.from(pdfChunks(MAX_DOCUMENT_BYTES + 1))), { statusCode: 413 });
  const truncated = Readable.from([pdf]);
  truncated.truncated = true;
  await assert.rejects(upload('truncated.pdf', truncated), { statusCode: 413 });
  assert.equal(count(), 1);
  assert.equal((await readdir(uploadDir)).length, 1);
});

test('rejects bad extensions, mismatched signatures, malformed archives and path-like names', async (t) => {
  const { upload, uploadDir, count } = await setup(t);
  for (const [name, bytes, statusCode] of [
    ['script.exe', pdf, 415],
    ['fake.jpg', pdf, 415],
    ['empty.pdf', Buffer.alloc(0), 415],
    ['fake.zip', Buffer.from('PK\x03\x04'), 415],
    ['fake.docx', zip, 415],
    ['../escape.pdf', pdf, 400],
    ['..\\escape.pdf', pdf, 400],
    ['bad\rname.pdf', pdf, 400],
  ]) {
    await assert.rejects(upload(name, Readable.from([bytes])), { statusCode });
  }
  assert.equal(count(), 0);
  assert.deepEqual(await readdir(uploadDir), []);
});

test('rejects truncated and malformed document structures without files or database rows', async (t) => {
  const { upload, uploadDir, count } = await setup(t);
  const badXref = Buffer.from(pdf.toString().replace(/startxref\n\d+/, 'startxref\n9'));
  const pngBounds = Buffer.from(png);
  pngBounds.writeUInt32BE(0x7fffffff, pngBounds.indexOf('IDAT') - 4);
  const jpegBounds = Buffer.from(jpeg);
  jpegBounds.writeUInt16BE(0xffff, 4);
  const badLocalName = Buffer.from(zip);
  badLocalName[30] ^= 1;
  const badDescriptor = Buffer.from(zip);
  badDescriptor[badDescriptor.indexOf(Buffer.from('504b0708', 'hex')) + 4] ^= 1;
  const badDirectoryCount = Buffer.from(zip);
  badDirectoryCount.writeUInt16LE(0, badDirectoryCount.length - 14);
  for (const [label, name, bytes] of [
    ['PDF missing EOF', 'notes.pdf', pdf.subarray(0, -6)],
    ['PDF cross-reference offset', 'notes.pdf', badXref],
    ['PNG missing IEND', 'figure.png', png.subarray(0, -12)],
    ['PNG chunk length', 'figure.png', pngBounds],
    ['JPEG missing EOI', 'photo.jpg', jpeg.subarray(0, -2)],
    ['JPEG segment length', 'photo.jpeg', jpegBounds],
    ['JPEG without frame or scan', 'photo.jpg', Buffer.from('ffd8ffd9', 'hex')],
    ['ZIP missing EOCD', 'notes.zip', zip.subarray(0, -1)],
    ['ZIP local filename mismatch', 'notes.zip', badLocalName],
    ['ZIP inconsistent data descriptor', 'notes.zip', badDescriptor],
    ['ZIP inconsistent directory count', 'notes.zip', badDirectoryCount],
    ['DOCX missing EOCD', 'notes.docx', docx.subarray(0, -1)],
    ['DOCX missing relationships', 'notes.docx', archive([docxParts[0], docxParts[2]])],
    ['DOCX empty document part', 'notes.docx', archive([...docxParts.slice(0, 2), ['word/document.xml', '']])],
    ['DOCX ambiguous duplicate parts', 'notes.docx', archive([...docxParts, 'WORD/document.xml'])],
    ['PNG submitted as JPEG', 'photo.jpg', png],
  ]) {
    await assert.rejects(upload(name, Readable.from([bytes])), { statusCode: 415 }, label);
  }
  assert.deepEqual(await readdir(uploadDir), []);
  assert.equal(count(), 0);
});

test('stream, database and filesystem failures leave no new document files or rows', async (t) => {
  const { dir, db, upload, uploadDir, count } = await setup(t);
  const broken = Readable.from((function* () {
    yield pdf;
    throw new Error('stream interrupted');
  })());
  await assert.rejects(upload('broken.pdf', broken), /stream interrupted/);
  db.exec(`CREATE TRIGGER reject_document BEFORE INSERT ON documents
           BEGIN SELECT RAISE(ABORT, 'insert rejected'); END`);
  await assert.rejects(upload('rejected.pdf', Readable.from([pdf])), /insert rejected/);
  const blocked = path.join(dir, 'blocked');
  await writeFile(blocked, 'keep');
  await assert.rejects(createDocument(db, blocked, teacher, {
    courseId: 'course', title: 'Blocked', originalFilename: 'blocked.pdf', source: Readable.from([pdf]),
  }));
  assert.equal(await readFile(blocked, 'utf8'), 'keep');
  assert.equal(count(), 0);
  assert.deepEqual(await readdir(uploadDir), []);
});

test('course authorization gates uploads and reads, and unsafe stored paths cannot be opened', async (t) => {
  const { dir, db, upload, uploadDir } = await setup(t);
  await assert.rejects(upload('student.pdf', Readable.from([pdf]), student), { statusCode: 403 });
  await assert.rejects(upload('other.pdf', Readable.from([pdf]), { ...teacher, sub: 'other' }), { statusCode: 403 });
  const { id } = await upload('notes.pdf', Readable.from([pdf]));
  db.exec('DELETE FROM enrollments');
  assert.throws(() => listDocuments(db, student, 'course'), { statusCode: 403 });
  await assert.rejects(readDocument(db, uploadDir, student, id), { statusCode: 403 });
  const changePath = db.prepare('UPDATE documents SET file_path = ? WHERE id = ?');
  await writeFile(path.join(dir, 'private.pdf'), pdf);
  changePath.run('../private.pdf', id);
  await assert.rejects(readDocument(db, uploadDir, teacher, id), { statusCode: 404 });
  // Directory junctions exercise the symlink guard on Windows without developer mode.
  await symlink(dir, path.join(uploadDir, id), process.platform === 'win32' ? 'junction' : 'dir');
  changePath.run(id, id);
  await assert.rejects(readDocument(db, uploadDir, teacher, id), { statusCode: 404 });
  await symlink(dir, path.join(uploadDir, `.${id}.document`), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readDocument(db, uploadDir, teacher, id), { statusCode: 404 });
});
