import { realpathSync } from 'node:fs';
import path from 'node:path';
import { config } from './config/env.js';
import { prepareUploadRoot } from './config/upload-root.js';
import { openDatabase } from './database/db.js';
import { runMigrations } from './database/migrate.js';
import { buildApp } from './app.js';
import { reconcileDocuments } from './modules/documents/documents.service.js';

const uploadRoot = prepareUploadRoot(config.uploadDir);
const db = openDatabase(config.databasePath);
const databaseRelativePath = path.relative(uploadRoot.getPath(), realpathSync.native(config.databasePath));
if (!path.isAbsolute(databaseRelativePath) &&
    databaseRelativePath !== '..' && !databaseRelativePath.startsWith(`..${path.sep}`)) {
  db.close();
  throw new Error('DATABASE_PATH must be outside UPLOAD_DIR');
}
const applied = runMigrations(db); // safe on a fresh or existing database
const app = buildApp({ config: { ...config, uploadDir: uploadRoot }, db });
if (applied.length) app.log.info({ applied }, 'migrations applied');

async function shutdown(signal) {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    db.close();
    process.exit(0);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await reconcileDocuments(db, uploadRoot);
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  db.close();
  process.exit(1);
}
