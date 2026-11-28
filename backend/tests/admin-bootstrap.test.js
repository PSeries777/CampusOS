import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/database/db.js';
import { runMigrations } from '../src/database/migrate.js';
import { verifyCredentials } from '../src/modules/auth/auth.service.js';
import { bootstrapAdmin } from '../src/modules/users/users.service.js';

test('bootstraps exactly one admin and accepts their login credentials', async () => {
  const db = openDatabase(':memory:');
  try {
    runMigrations(db);
    const credentials = {
      full_name: ' Demo Admin ',
      email: ' ADMIN@campus.test ',
      password: 'demo-admin-password',
    };
    await assert.rejects(bootstrapAdmin(db, { ...credentials, password: 'short' }), { code: 'VALIDATION_ERROR' });
    const results = await Promise.allSettled([bootstrapAdmin(db, credentials), bootstrapAdmin(db, credentials)]);
    const created = results.find((result) => result.status === 'fulfilled').value;
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'ADMIN_EXISTS');
    assert.equal(created.role, 'admin');
    assert.equal(created.email, 'admin@campus.test');
    assert.deepEqual(await verifyCredentials(db, credentials), created);
    assert.notEqual(db.prepare('SELECT password_hash FROM users').get().password_hash, credentials.password);
  } finally {
    db.close();
  }
});
