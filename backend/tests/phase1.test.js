import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrate.js';
import { buildApp } from '../src/app.js';

let dir, db, app;
const config = { nodeEnv: 'test', isProduction: false, logLevel: 'silent' };

// Authoritative SRS structure: exact column set and primary key per table.
const SCHEMA = {
  users:               { columns: ['id','full_name','email','password_hash','role','created_at'], pk: ['id'] },
  courses:             { columns: ['id','course_code','title','teacher_id'], pk: ['id'] },
  enrollments:         { columns: ['course_id','student_id','enrolled_at'], pk: ['course_id','student_id'] },
  attendance_sessions: { columns: ['id','course_id','otp_code','is_active','started_at','ended_at'], pk: ['id'] },
  attendance_records:  { columns: ['id','session_id','student_id','device_fingerprint','punched_at'], pk: ['id'] },
  documents:           { columns: ['id','course_id','uploaded_by','title','description','file_path','file_size','mime_type','uploaded_at','original_filename'], pk: ['id'] },
  assessments:         { columns: ['id','course_id','title','max_marks','weightage','created_at'], pk: ['id'] },
  student_marks:       { columns: ['assessment_id','student_id','marks_obtained','feedback','updated_at'], pk: ['assessment_id','student_id'] },
};

const columnNames = (table) =>
  db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').pluck().all(table);
const primaryKey = (table) =>
  db.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk').pluck().all(table);
const uniqueIndexes = (table) =>
  db.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique" = 1').pluck().all(table)
    .map((idx) => db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').pluck().all(idx).join(','));
const indexNames = () =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").pluck().all();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-'));
  db = openDatabase(path.join(dir, 'test.sqlite'));
  runMigrations(db);
  app = buildApp({ config, db });
  await app.ready();
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pragmas are applied', () => {
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('synchronous', { simple: true }), 1); // NORMAL
  assert.equal(db.pragma('temp_store', { simple: true }), 2);  // MEMORY
  assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
});

test('no unexpected tables exist', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'")
    .pluck().all().sort();
  assert.deepEqual(tables, Object.keys(SCHEMA).sort());
});

for (const [table, { columns, pk }] of Object.entries(SCHEMA)) {
  test(`${table}: exact SRS columns`, () => {
    const actual = columnNames(table);
    const missing = columns.filter((c) => !actual.includes(c));
    const unexpected = actual.filter((c) => !columns.includes(c));
    assert.deepEqual({ missing, unexpected }, { missing: [], unexpected: [] }, `${table} column mismatch`);
  });

  test(`${table}: primary key is (${pk.join(', ')})`, () => {
    assert.deepEqual(primaryKey(table), pk);
  });
}

test('attendance_records has both anti-duplicate UNIQUE constraints', () => {
  const unique = uniqueIndexes('attendance_records');
  assert.ok(unique.includes('session_id,student_id'), 'missing UNIQUE(session_id, student_id)');
  assert.ok(unique.includes('session_id,device_fingerprint'), 'missing UNIQUE(session_id, device_fingerprint)');
});

test('required indexes exist', () => {
  const names = indexNames();
  for (const idx of ['idx_courses_teacher','idx_enrollments_student','idx_sessions_course_active',
    'idx_records_student','idx_documents_course','idx_assessments_course','idx_marks_student'])
    assert.ok(names.includes(idx), `missing index ${idx}`);
});

test('migrations are idempotent', () => {
  assert.deepEqual(runMigrations(db), []);
});

test('foreign keys are enforced', () => {
  assert.throws(() => db.prepare(
    "INSERT INTO courses (id, course_code, title, teacher_id) VALUES ('cx','X','X','missing')").run(), /FOREIGN KEY/);
});

test('constraint behavior: attendance, enrollments, marks, checks', () => {
  const user = db.prepare('INSERT INTO users (id,full_name,email,password_hash,role) VALUES (?,?,?,?,?)');
  user.run('t1', 'Teacher', 't@x.com', 'h', 'teacher');
  user.run('s1', 'Student One', 's1@x.com', 'h', 'student');
  user.run('s2', 'Student Two', 's2@x.com', 'h', 'student');
  assert.throws(() => user.run('s3', 'Bad Role', 'b@x.com', 'h', 'janitor'), /CHECK/);

  db.prepare("INSERT INTO courses (id,course_code,title,teacher_id) VALUES ('c1','CS101','Intro','t1')").run();

  // enrollments: composite PK blocks duplicates
  const enroll = db.prepare('INSERT INTO enrollments (course_id, student_id) VALUES (?,?)');
  enroll.run('c1', 's1');
  assert.throws(() => enroll.run('c1', 's1'), /UNIQUE|PRIMARY KEY/);

  // attendance
  const session = db.prepare("INSERT INTO attendance_sessions (id,course_id,otp_code) VALUES (?,?,?)");
  session.run('a1', 'c1', '123456');
  assert.throws(() => session.run('a2', 'c1', '12345'), /CHECK/);   // too short
  assert.throws(() => session.run('a3', 'c1', '12345x'), /CHECK/);  // non-digit
  const punch = db.prepare('INSERT INTO attendance_records (id,session_id,student_id,device_fingerprint) VALUES (?,?,?,?)');
  punch.run('r1', 'a1', 's1', 'dev-A');
  assert.throws(() => punch.run('r2', 'a1', 's1', 'dev-B'), /UNIQUE/); // same student twice
  assert.throws(() => punch.run('r3', 'a1', 's2', 'dev-A'), /UNIQUE/); // same device, other student

  // assessments / marks
  assert.throws(() => db.prepare("INSERT INTO assessments (id,course_id,title,max_marks,weightage) VALUES ('x','c1','T',0,10)").run(), /CHECK/);
  db.prepare("INSERT INTO assessments (id,course_id,title,max_marks,weightage) VALUES ('as1','c1','Quiz',50,20)").run();
  const mark = db.prepare('INSERT INTO student_marks (assessment_id,student_id,marks_obtained) VALUES (?,?,?)');
  mark.run('as1', 's1', 40);
  assert.throws(() => mark.run('as1', 's1', 41), /UNIQUE|PRIMARY KEY/); // composite PK
  assert.throws(() => mark.run('as1', 's2', -1), /CHECK/);
});

test('GET /api/health', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.database.journalMode, 'wal');
});

test('unknown route returns JSON 404', async () => {
  const res = await app.inject({ method: 'GET', url: '/nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'NOT_FOUND');
});
