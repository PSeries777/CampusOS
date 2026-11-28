import { newId } from '../../utils/ids.js';
import { hashPassword, normalizeEmail } from '../auth/auth.service.js';
import { ConflictError, ValidationError } from '../../utils/errors.js';

async function prepareUser({ full_name, email, password }, role) {
  const name = full_name.trim();
  const address = normalizeEmail(email);
  if (!name || name.length > 120) throw new ValidationError('Enter a name of 1 to 120 characters.');
  if (address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new ValidationError('Enter a valid email address.');
  }
  if ([...password].length < 12 || Buffer.byteLength(password) > 72 || password.includes('\0')) {
    throw new ValidationError('Use a password of at least 12 characters and at most 72 UTF-8 bytes, without null characters.');
  }
  return { id: newId(), full_name: name, email: address, role, passwordHash: await hashPassword(password) };
}

function insertUser(db, { passwordHash, ...user }) {
  try {
    db.prepare('INSERT INTO users (id, full_name, email, role, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, user.full_name, user.email, user.role, passwordHash);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new ConflictError('EMAIL_ALREADY_REGISTERED', 'This email is already registered.');
    }
    throw error;
  }
  return user;
}

export function listUsers(db) {
  return db.prepare(
    'SELECT id, full_name, email, role FROM users ORDER BY full_name COLLATE NOCASE, email',
  ).all();
}

export async function createUser(db, credentials) {
  if (credentials.role !== 'teacher' && credentials.role !== 'student') {
    throw new ValidationError('Choose teacher or student.');
  }
  return insertUser(db, await prepareUser(credentials, credentials.role));
}

export async function bootstrapAdmin(db, credentials) {
  const user = await prepareUser(credentials, 'admin');
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) {
      throw new ConflictError('ADMIN_EXISTS', 'An admin account already exists.');
    }
    return insertUser(db, user);
  }).immediate();
}
