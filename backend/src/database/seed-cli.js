import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { config } from '../config/env.js';
import { bootstrapAdmin } from '../modules/users/users.service.js';
import { openDatabase } from './db.js';
import { runMigrations } from './migrate.js';

async function main() {
  if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal.');

  let hidden = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!hidden) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  let credentials;
  try {
    const full_name = await input.question('Admin name: ');
    const email = await input.question('Admin email: ');
    process.stdout.write('Admin password (hidden): ');
    hidden = true;
    const password = await input.question('');
    process.stdout.write('\nConfirm password (hidden): ');
    const confirmation = await input.question('');
    process.stdout.write('\n');
    if (password !== confirmation) throw new Error('Passwords do not match.');
    credentials = { full_name, email, password };
  } finally {
    input.close();
  }

  const db = openDatabase(config.databasePath);
  try {
    runMigrations(db);
    const { email } = await bootstrapAdmin(db, credentials);
    console.log('Admin created. Sign in as ' + email + '.');
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
