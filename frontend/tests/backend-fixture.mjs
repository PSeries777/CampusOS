import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const copy = pathToFileURL(resolve('tests/.backend') + '/');
const original = pathToFileURL(resolve('../backend') + '/');
const loadBackend = createRequire(new URL('package.json', copy));

if (process.argv.includes('--prepare')) {
  await mkdir(copy, { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'src']) {
    await cp(new URL(file, original), new URL(file, copy), { recursive: true });
  }
}

export const testAccounts = {
  teacher: {
    email: 'teacher@integration.test',
    full_name: 'Test Teacher',
    role: 'teacher',
  },
  student: {
    email: 'student@integration.test',
    full_name: 'Test Student',
    role: 'student',
  },
  second: {
    email: 'second@integration.test',
    full_name: 'Second Student',
    role: 'student',
  },
  admin: {
    email: 'admin@integration.test',
    full_name: 'Test Admin',
    role: 'admin',
  },
};
export const password = 'CampusOS-Local-Test-Only';

export async function createBackend({ seed = true } = {}) {
  const { openDatabase } = loadBackend('./src/database/db.js');
  const { runMigrations } = loadBackend('./src/database/migrate.js');
  const { buildApp } = loadBackend('./src/app.js');
  const { bootstrapAdmin } = loadBackend('./src/modules/users/users.service.js');
  const uploadDir = await mkdtemp(join(tmpdir(), 'campusos-fixture-'));
  const db = openDatabase(':memory:');
  runMigrations(db);
  const { accounts, course } = seed ? await seedDemo(db) : {};
  const app = buildApp({
    db,
    config: {
      nodeEnv: 'test',
      isProduction: false,
      logLevel: 'silent',
      jwtSecret: randomUUID(),
      jwtExpiresIn: '1h',
      uploadDir,
    },
  });
  app.addHook('onClose', async () => {
    db.close();
    await rm(uploadDir, { recursive: true, force: true });
  });
  await app.ready();
  return { app, accounts, course, bootstrap: (credentials) => bootstrapAdmin(db, credentials) };
}

async function seedDemo(db) {
  const { hashPassword } = loadBackend('./src/modules/auth/auth.service.js');
  const hash = await hashPassword(password);
  const accounts = Object.fromEntries(
    Object.entries(testAccounts).map(([key, value]) => [
      key,
      { ...value, id: randomUUID() },
    ]),
  );
  const addUser = db.prepare(
    'INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?,?,?,?,?)',
  );
  for (const account of Object.values(accounts))
    addUser.run(
      account.id,
      account.full_name,
      account.email,
      hash,
      account.role,
    );
  const course = randomUUID();
  db.prepare(
    'INSERT INTO courses (id, course_code, title, teacher_id) VALUES (?, ?, ?, ?)',
  ).run(course, 'CS101', 'Computer Science', accounts.teacher.id);
  for (const student of [accounts.student, accounts.second]) {
    db.prepare(
      'INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)',
    ).run(student.id, course);
  }
  return { accounts, course };
}

if (process.argv.includes('--serve')) {
  const { app } = await createBackend();
  const address = await app.listen({ host: '127.0.0.1', port: 8080 });
  console.log('CampusOS test API at ' + address);
  console.log(
    Object.values(testAccounts)
      .map(({ email }) => email)
      .join(', '),
  );
  console.log('Local test password: ' + password);
}
