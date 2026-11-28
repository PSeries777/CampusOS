import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrate.js';
import { bootstrapAdmin } from '../src/modules/users/users.service.js';

test('only admins can list and provision teacher and student accounts', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, config: { logLevel: 'silent', jwtSecret: 'users-test-secret', jwtExpiresIn: '1h' } });
  try {
    runMigrations(db);
    const admin = await bootstrapAdmin(db, {
      full_name: 'Admin', email: 'admin@campus.test', password: 'demo-admin-password',
    });
    await app.ready();
    const auth = (user) => ({
      authorization: 'Bearer ' + app.jwt.sign({ sub: user.id, role: user.role }),
    });
    const headers = auth(admin);
    const teacher = {
      full_name: 'Course Teacher', email: ' TEACHER@campus.test ', password: 'demo-teacher-password', role: 'teacher',
    };
    const student = {
      full_name: 'Course Student', email: 'student@campus.test', password: 'demo-student-password', role: 'student',
    };
    const list = (headers) => app.inject({ method: 'GET', url: '/api/users', headers });
    const create = (headers, payload) => app.inject({ method: 'POST', url: '/api/users', headers, payload });

    assert.equal((await list()).statusCode, 401);
    assert.equal((await create(undefined, teacher)).statusCode, 401);
    assert.equal((await create(headers, { ...teacher, role: 'admin' })).statusCode, 400);
    const expected = [admin];
    for (const input of [teacher, student]) {
      const response = await create(headers, input);
      assert.equal(response.statusCode, 201);
      const account = response.json().data;
      assert.deepEqual(account, { id: account.id, full_name: input.full_name, email: input.email.trim().toLowerCase(), role: input.role });
      assert.equal((await list(auth(account))).statusCode, 403);
      assert.equal((await create(auth(account), student)).statusCode, 403);
      expected.push(account);
    }
    const duplicate = await create(headers, { ...student, email: 'Student@Campus.test' });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error.code, 'EMAIL_ALREADY_REGISTERED');
    assert.deepEqual((await list(headers)).json().data, [expected[0], expected[2], expected[1]]);
  } finally {
    await app.close();
    db.close();
  }
});
