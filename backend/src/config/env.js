import 'dotenv/config';
import path from 'node:path';
import { readDocumentConfig } from './documents.js';

const nodeEnv = process.env.NODE_ENV ?? 'development';
const jwtSecret = process.env.JWT_SECRET;

const secretForValidation = jwtSecret?.trim() ?? '';
const normalizedSecret = secretForValidation.toLowerCase().replace(/[^a-z0-9]/g, '');
const placeholder = /^(?:changeme|replaceme|replace(?:this|with)|your(?:jwt|secret|256bit)|insert(?:your|secret)|example(?:jwt|secret)|placeholder|default(?:jwt|secret)|insecure(?:jwt|secret)|supersecret)/;
const predictable = /^(.{1,8})\1+$/s.test(secretForValidation) ||
  (normalizedSecret.length >= 32 && ['abcdefghijklmnopqrstuvwxyz', '0123456789', '1234567890'].some((sequence) =>
    sequence.repeat(Math.ceil(normalizedSecret.length / sequence.length)).startsWith(normalizedSecret)));

if (secretForValidation.length < 32 || placeholder.test(normalizedSecret) || predictable) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters');
}

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

export const config = Object.freeze({
  ...readDocumentConfig(process.env),
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port,
  host: process.env.HOST?.trim() || '127.0.0.1',
  databasePath: path.resolve(process.env.DATABASE_PATH ?? './data/sms.sqlite'),
  uploadDir: path.resolve(process.env.UPLOAD_DIR ?? './uploads'),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  logLevel: process.env.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug'),
});
