import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrate.js';
import { newId } from '../src/utils/ids.js';

test('marks are persistent, scoped to the course owner and private to each enrolled student', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, config: { logLevel: 'silent', jwtSecret: 'marks-test-secret', jwtExpiresIn: '1h' } });
  try {
    runMigrations(db);
    await app.ready();
    const add = db.prepare('INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)');
    const account = (name, role) => {
      const id = newId();
      add.run(id, name, name + '@campus.test', 'unused', role);
      return { id, token: app.jwt.sign({ sub: id, role }) };
    };
    const teacher = account('Teacher', 'teacher');
    const otherTeacher = account('Other Teacher', 'teacher');
    const student = account('Student', 'student');
    const peer = account('Peer', 'student');
    const outsider = account('Outsider', 'student');
    const courseId = newId();
    const secondCourse = newId();
    const addCourse = db.prepare('INSERT INTO courses (id, course_code, title, teacher_id) VALUES (?, ?, ?, ?)');
    addCourse.run(courseId, 'DB101', 'Database Systems', teacher.id);
    addCourse.run(secondCourse, 'DB102', 'Data Modeling', teacher.id);
    for (const { id } of [student, peer]) {
      db.prepare('INSERT INTO enrollments (course_id, student_id) VALUES (?, ?)').run(courseId, id);
    }
    const base = '/api/courses/' + courseId + '/assessments';
    const call = (method, url, user, payload) => app.inject({
      method, url, payload, headers: user ? { authorization: 'Bearer ' + user.token } : {},
    });
    const assessmentInput = { title: ' Quiz ', max_marks: 20 };
    assert.equal((await call('GET', base)).statusCode, 401);
    assert.equal((await call('GET', base, outsider)).statusCode, 403);
    assert.equal((await call('POST', base, otherTeacher, assessmentInput)).statusCode, 403);
    assert.equal((await call('POST', base, student, assessmentInput)).statusCode, 403);
    assert.equal((await call('POST', base, teacher, { ...assessmentInput, max_marks: 0 })).statusCode, 400);
    const created = await call('POST', base, teacher, assessmentInput);
    assert.equal(created.statusCode, 201);
    const { id } = created.json().data;
    const roster = base + '/' + id + '/marks';
    const target = roster + '/' + student.id;

    assert.equal((await call('GET', roster, student)).statusCode, 403);
    assert.equal((await call('PUT', target, otherTeacher, { marks_obtained: 5 })).statusCode, 403);
    assert.equal((await call('PUT', target, student, { marks_obtained: 5 })).statusCode, 403);
    assert.equal((await call('GET', roster.replace(courseId, secondCourse), teacher)).statusCode, 404);
    assert.equal((await call('PUT', roster + '/' + outsider.id, teacher, { marks_obtained: 5 })).statusCode, 404);
    for (const score of [null, '', -1, 21]) {
      assert.equal((await call('PUT', target, teacher, { marks_obtained: score })).statusCode, 400);
    }
    const before = (await call('GET', base, student)).json().data;
    assert.equal(before[0].marks_obtained, null);

    for (const score of [12.5, 0]) {
      assert.equal((await call('PUT', target, teacher, { marks_obtained: score })).statusCode, 200);
      assert.deepEqual((await call('GET', base, student)).json().data,
        [{ id, title: 'Quiz', max_marks: 20, marks_obtained: score }]);
      assert.equal((await call('GET', base, peer)).json().data[0].marks_obtained, null);
    }
    assert.deepEqual((await call('GET', roster, teacher)).json().data.map((row) =>
      [row.student_id, row.marks_obtained]), [[peer.id, null], [student.id, 0]]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM student_marks').get().n, 1);
  } finally {
    await app.close();
    db.close();
  }
});
