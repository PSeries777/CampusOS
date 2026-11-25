import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcrypt';
import { openDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, BCRYPT_COST } from '../src/modules/auth/auth.service.js';
import { authenticate } from '../src/middleware/authenticate.js';
import { authorize } from '../src/middleware/authorize.js';
import { newId } from '../src/utils/ids.js';
import { ok } from '../src/utils/response.js';

const TEST_CONFIG = {
  nodeEnv: 'test',
  isProduction: false,
  logLevel: 'silent',
  jwtSecret: 'phase2-test-secret-not-for-production-0123456789',
  jwtExpiresIn: '1h',
};

// Test-only credentials; created in an isolated temp DB, never in seed data.
const USERS = {
  admin:   { full_name: 'Test Admin',   email: 'admin@example.test',   password: 'Admin#Pass123',   role: 'admin' },
  teacher: { full_name: 'Test Teacher', email: 'teacher@example.test', password: 'Teacher#Pass123', role: 'teacher' },
  student: { full_name: 'Test Student', email: 'student@example.test', password: 'Student#Pass123', role: 'student' },
};

let dir, db, app;
const tokens = {};
const spy = { teacher: 0, admin: 0 };

async function spyRoutes(instance) {
  instance.get('/test/teacher-only', { onRequest: [authenticate, authorize('teacher')] }, async () => {
    spy.teacher += 1;
    return ok({ reached: true });
  });
  instance.get('/test/admin-only', { onRequest: [authenticate, authorize('admin')] }, async () => {
    spy.admin += 1;
    return ok({ reached: true });
  });
}

const login = (email, password) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

const startAttendance = (token, payload = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/attendance/start',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload,
  });

const get = (url, token) =>
  app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const decodePayload = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

// Hand-built HS256 token so expiry/tamper cases don't depend on signer-library quirks.
function forgeToken(payload, { secret = TEST_CONFIG.jwtSecret, alg = 'HS256' } = {}) {
  const head = b64({ alg, typ: 'JWT' });
  const body = b64(payload);
  const sig = alg === 'none' ? '' : crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
const now = () => Math.floor(Date.now() / 1000);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-p2-'));
  db = openDatabase(path.join(dir, 'test.sqlite'));
  runMigrations(db);

  const insert = db.prepare('INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?,?,?,?,?)');
  for (const u of Object.values(USERS)) {
    u.id = newId();
    insert.run(u.id, u.full_name, u.email, await hashPassword(u.password), u.role);
  }

  app = buildApp({ config: TEST_CONFIG, db });
  app.register(spyRoutes);
  await app.ready();

  for (const [role, u] of Object.entries(USERS)) {
    tokens[role] = (await login(u.email, u.password)).json().data.token;
  }
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ───────────────────────── SRS acceptance tests ─────────────────────────

test('TC-AUTH-01: valid login returns 200 and a JWT with the correct role claim', async () => {
  for (const [role, u] of Object.entries(USERS)) {
    const res = await login(u.email, u.password);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(typeof body.data.token, 'string');
    assert.deepEqual(body.data.user, { id: u.id, full_name: u.full_name, email: u.email, role });

    const claims = app.jwt.verify(body.data.token);
    assert.equal(claims.role, role);
    assert.equal(claims.sub, u.id);
    assert.ok(claims.exp > claims.iat, 'token must carry an expiry');
  }
});

test('TC-AUTH-02: unknown email and wrong password give the same generic 401', async () => {
  const unknownEmail = await login('nobody@example.test', 'Whatever#123');
  const wrongPassword = await login(USERS.student.email, 'Wrong#Password1');
  for (const res of [unknownEmail, wrongPassword]) {
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().success, false);
    assert.equal(res.json().error.message, 'Invalid credentials');
  }
  assert.deepEqual(unknownEmail.json(), wrongPassword.json());
});

test('TC-AUTH-03: student JWT on POST /api/attendance/start gets 403', async () => {
  const res = await startAttendance(tokens.student);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().success, false);
  assert.equal(res.json().error.code, 'FORBIDDEN');
});

test('TC-AUTH-04a: protected endpoint without Authorization header gets 401', async () => {
  const res = await startAttendance(null);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().success, false);
});

test('TC-AUTH-04b: expired JWT gets 401', async () => {
  // Control: the same forged shape with a future expiry is accepted, so the 401 below is due to expiry.
  const control = forgeToken({ sub: USERS.teacher.id, role: 'teacher', iat: now(), exp: now() + 3600 });
  assert.notEqual((await startAttendance(control)).statusCode, 401);

  const expired = forgeToken({ sub: USERS.teacher.id, role: 'teacher', iat: now() - 7200, exp: now() - 3600 });
  const res = await startAttendance(expired);
  assert.equal(res.statusCode, 401);
});

// ───────────────────────── Supporting tests (not SRS acceptance criteria) ─────────────────────────

test('AUTH-UNIT-01: password is never stored as plaintext', () => {
  for (const u of Object.values(USERS)) {
    const { password_hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id);
    assert.notEqual(password_hash, u.password);
    assert.ok(!password_hash.includes(u.password));
    assert.match(password_hash, /^\$2[aby]\$/);
  }
});

test('AUTH-UNIT-02: stored hashes use bcrypt cost 10', async () => {
  assert.equal(BCRYPT_COST, 10);
  const { password_hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(USERS.student.id);
  assert.equal(bcrypt.getRounds(password_hash), 10);
  assert.equal(bcrypt.getRounds(await hashPassword('another-password')), 10);
});

test('AUTH-UNIT-03: a valid JWT verifies and is accepted by a protected route', async () => {
  assert.equal(app.jwt.verify(tokens.teacher).role, 'teacher');
  const res = await startAttendance(tokens.teacher);
  assert.notEqual(res.statusCode, 401);
  assert.notEqual(res.statusCode, 403);
});

test('AUTH-UNIT-04: malformed or untrusted JWTs are rejected with 401', async () => {
  const future = { sub: USERS.teacher.id, role: 'teacher', iat: now(), exp: now() + 3600 };
  const badTokens = [
    'garbage',
    'not.a.jwt',
    `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(future)}`,                // missing signature
    forgeToken(future, { secret: 'a-different-secret-entirely-0123456789' }), // wrong secret
    forgeToken(future, { alg: 'none' }),                                    // alg=none
    forgeToken({ ...future, role: 'superuser' }),                           // valid signature, invalid role
    forgeToken({ role: 'teacher', iat: now(), exp: now() + 3600 }),         // valid signature, no sub
  ];
  for (const token of badTokens) {
    const res = await startAttendance(token);
    assert.equal(res.statusCode, 401, `expected 401 for token ${token.slice(0, 30)}...`);
  }
  const wrongScheme = await app.inject({
    method: 'POST', url: '/api/attendance/start', headers: { authorization: `Basic ${tokens.teacher}` },
  });
  assert.equal(wrongScheme.statusCode, 401);
});

test('AUTH-UNIT-05: expired JWT is rejected by verification', () => {
  const expired = forgeToken({ sub: USERS.teacher.id, role: 'teacher', iat: now() - 7200, exp: now() - 3600 });
  assert.throws(() => app.jwt.verify(expired));
});

test('AUTH-UNIT-06: teacher can reach a teacher-protected operation', async () => {
  const before = spy.teacher;
  const res = await get('/test/teacher-only', tokens.teacher);
  assert.equal(res.statusCode, 200);
  assert.equal(spy.teacher, before + 1);

  // The real route lets teachers and admins through authentication/authorization. With an empty
  // body they reach request validation (400), which proves they were not stopped by the guards.
  for (const role of ['teacher', 'admin']) {
    const res = await startAttendance(tokens[role]);
    assert.notEqual(res.statusCode, 401);
    assert.notEqual(res.statusCode, 403);
    assert.equal(res.statusCode, 400);
  }
});

test('AUTH-UNIT-07: student cannot access teacher/admin-protected operations', async () => {
  assert.equal((await get('/test/teacher-only', tokens.student)).statusCode, 403);
  assert.equal((await get('/test/admin-only', tokens.student)).statusCode, 403);
});

test('supporting: roles are not implied (teacher is not admin, admin is not teacher)', async () => {
  assert.equal((await get('/test/admin-only', tokens.teacher)).statusCode, 403);
  assert.equal((await get('/test/teacher-only', tokens.admin)).statusCode, 403);
});

test('supporting: authorization rejects before the controller/handler runs', async () => {
  const before = { ...spy };
  assert.equal((await get('/test/teacher-only', tokens.student)).statusCode, 403);
  assert.equal((await get('/test/admin-only', tokens.teacher)).statusCode, 403);
  assert.equal((await get('/test/teacher-only')).statusCode, 401);
  assert.deepEqual(spy, before, 'handlers must not run when auth fails');

  // Rejected before body parsing too: a student sending a body still gets 403.
  assert.equal((await startAttendance(tokens.student, { course_id: 'anything' })).statusCode, 403);
});

test('supporting: login response contains no password or password_hash', async () => {
  const u = USERS.student;
  const { password_hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id);
  const res = await login(u.email, u.password);
  const raw = res.body;
  assert.ok(!raw.includes('password_hash'));
  assert.ok(!raw.includes(password_hash));
  assert.ok(!raw.includes(u.password));
  assert.deepEqual(Object.keys(res.json().data.user).sort(), ['email', 'full_name', 'id', 'role']);
});

test('supporting: JWT payload holds identity + role + timestamps only, no password data', () => {
  const claims = decodePayload(tokens.student);
  assert.deepEqual(Object.keys(claims).sort(), ['exp', 'iat', 'role', 'sub']);
  const { password_hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(USERS.student.id);
  const raw = JSON.stringify(claims);
  assert.ok(!raw.includes(USERS.student.password));
  assert.ok(!raw.includes(password_hash));
});

test('supporting: email lookup is case-insensitive and whitespace-tolerant', async () => {
  const res = await login('  STUDENT@Example.Test ', USERS.student.password);
  assert.equal(res.statusCode, 200);
});

test('supporting: login body validation returns 400 for missing fields', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@b.test' } });
  assert.equal(res.statusCode, 400);
});

test('supporting: JWT secret comes from configuration/environment, not source code', async () => {
  // A token signed with the configured secret is accepted; any other secret is not.
  const claims = { sub: USERS.teacher.id, role: 'teacher', iat: now(), exp: now() + 3600 };
  assert.notEqual((await startAttendance(forgeToken(claims))).statusCode, 401);
  assert.equal((await startAttendance(forgeToken(claims, { secret: 'something-else-0123456789012345' }))).statusCode, 401);

  // env.js reads JWT_SECRET from the environment and refuses weak ones in production.
  const saved = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET };
  try {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'env-provided-secret-for-test-9b7c2104';
    const { config } = await import('../src/config/env.js?case=dev');
    assert.equal(config.jwtSecret, 'env-provided-secret-for-test-9b7c2104');

    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'too-short';
    await assert.rejects(import('../src/config/env.js?case=prod-weak'), /JWT_SECRET/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
