import { constants, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { documentDefaults } from '../../config/documents.js';
import { FileUploadError, NotFoundError } from '../../utils/errors.js';
import { newId } from '../../utils/ids.js';
import { UUID_PATTERN } from '../../utils/validation.js';
import { invalidFile, validateContents } from './documents.validation.js';

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const STORAGE_KEY = new RegExp(UUID_PATTERN, 'i');
const RECOVERY_FILE = new RegExp(`^\\.(${UUID_PATTERN.slice(1, -1)})\\.(document|delete)$`);
const CONTENT = 'content';
const MARKER = 'v1';
const TYPES = new Map([
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.zip', 'application/zip'],
]);

function documentExtension(filename) {
  if (typeof filename !== 'string' || Buffer.byteLength(filename) > 255 ||
      /[\\/\x00-\x1f\x7f]/.test(filename)) {
    throw new FileUploadError(400, 'INVALID_FILENAME', 'A valid original filename is required');
  }
  const extension = path.extname(filename).toLowerCase();
  if (!TYPES.has(extension)) throw invalidFile();
  return extension;
}

async function storageRoot(uploadDir) {
  if (typeof uploadDir !== 'string') return uploadDir.getPath();
  const root = path.resolve(uploadDir);
  if (!(await lstat(root)).isDirectory()) throw new Error('Invalid document storage directory');
  return realpath(root);
}

function documentDirectory(root, key) {
  return path.join(root, `.${key}.document`);
}

function assertSameDirectory(directory, expected) {
  const current = statIfPresent(directory);
  if (!current?.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error('Reserved document directory changed');
  }
}

function reserveDocument(root, getStorageKey, isReferenced) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const key = getStorageKey();
    if (!STORAGE_KEY.test(key)) throw new Error('Invalid generated document key');
    const directory = documentDirectory(root, key);
    if (isReferenced(key) || statIfPresent(path.join(root, key)) ||
        statIfPresent(path.join(root, `.${key}.delete`)) ||
        statIfPresent(path.join(root, `.${key}.quarantine`)) ||
        statIfPresent(path.join(root, `.${key}.part`))) continue;
    try {
      mkdirSync(directory, { mode: 0o700 });
      return { key, directory, identity: lstatSync(directory) };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Could not reserve a unique document key');
}

// The reserved directory holds staged bytes until the synchronous SQLite commit publishes them.
// Startup may remove unreferenced reservations. No filesystem overwrite is used for publication.
export async function storeDocumentFile(uploadDir, source, originalFilename, persist, {
  finishUpload, signal, maxArchiveEntries = documentDefaults.documentArchiveMaxEntries,
  getStorageKey = newId, isReferenced = () => false,
} = {}) {
  const extension = documentExtension(originalFilename);
  signal?.throwIfAborted();
  if (typeof uploadDir === 'string') await mkdir(uploadDir, { recursive: true, mode: 0o700 });
  const root = await storageRoot(uploadDir);
  signal?.throwIfAborted();
  const { key: storageKey, directory, identity } = reserveDocument(root, getStorageKey, isReferenced);
  const stagePath = path.join(directory, CONTENT);
  let size = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > MAX_DOCUMENT_BYTES) {
        callback(new FileUploadError(413, 'PAYLOAD_TOO_LARGE', 'Document exceeds 50 MiB'));
        return;
      }
      callback(null, chunk);
    },
  });

  let stage;
  function checkReservation() {
    if (typeof uploadDir !== 'string') uploadDir.getPath();
    assertSameDirectory(directory, identity);
  }
  try {
    checkReservation();
    writeFileSync(path.join(directory, MARKER), '', { flag: 'wx', mode: 0o600 });
    stage = await open(stagePath, 'wx', 0o600);
    checkReservation();
    if (source.destroyed && !source.readableEnded) {
      throw source.errored ?? new FileUploadError(400, 'INCOMPLETE_UPLOAD', 'Document upload ended early');
    }
    await pipeline(source, meter, stage.createWriteStream(), { signal });
    if (source.truncated) throw new FileUploadError(413, 'PAYLOAD_TOO_LARGE', 'Document exceeds 50 MiB');
    if (finishUpload) await finishUpload();
    signal?.throwIfAborted();
    checkReservation();
    await validateContents(stagePath, extension, size, maxArchiveEntries, signal);
    signal?.throwIfAborted();
    checkReservation();
    return persist({ storageKey, size, mimeType: TYPES.get(extension) });
  } catch (err) {
    try {
      await stage?.close();
      checkReservation();
      removeReservation(directory);
    } catch (cleanupError) {
      throw new AggregateError([err, cleanupError], 'Document storage cleanup failed');
    }
    throw err;
  }
}

export async function openDocumentFile(uploadDir, storageKey) {
  if (typeof storageKey !== 'string' || !STORAGE_KEY.test(storageKey)) throw new NotFoundError('Document file not found');
  try {
    const root = await storageRoot(uploadDir);
    const directory = documentDirectory(root, storageKey);
    const reservation = statIfPresent(directory);
    const legacy = path.join(root, storageKey);
    if (reservation && (!reservation.isDirectory() || !hasMarker(directory) || statIfPresent(legacy))) {
      throw new NotFoundError('Document file not found');
    }
    const filePath = reservation ? path.join(directory, CONTENT) : legacy;
    const entry = await lstat(filePath);
    if (!entry.isFile()) throw new NotFoundError('Document file not found');
    const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const actual = await file.stat();
      if (typeof uploadDir !== 'string') uploadDir.getPath();
      if (reservation) assertSameDirectory(directory, reservation);
      if (!actual.isFile() || actual.dev !== entry.dev || actual.ino !== entry.ino) {
        throw new NotFoundError('Document file not found');
      }
      return { stream: file.createReadStream(), size: actual.size };
    } catch (err) {
      await file.close();
      throw err;
    }
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ELOOP') throw new NotFoundError('Document file not found');
    throw err;
  }
}

function statIfPresent(filePath, options) {
  try {
    return lstatSync(filePath, options);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function hasMarker(directory) {
  const marker = statIfPresent(path.join(directory, MARKER));
  return marker?.isFile() && marker.size === 0;
}

function removeReservation(directory) {
  if (!statIfPresent(directory)?.isDirectory()) return;
  const names = readdirSync(directory);
  if (!names.length) {
    rmdirSync(directory); // Interrupted between reserve and marker, or during cleanup.
    return;
  }
  const content = path.join(directory, CONTENT);
  if (!hasMarker(directory) || names.some((name) => name !== MARKER && name !== CONTENT) ||
      (names.includes(CONTENT) && !statIfPresent(content)?.isFile())) return;
  if (names.includes(CONTENT)) unlinkSync(content);
  unlinkSync(path.join(directory, MARKER));
  rmdirSync(directory);
}

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.birthtimeNs, stat.mtimeNs].join(':');
}

function finishLegacyDelete(root, key, marker, referenced) {
  const journal = statIfPresent(marker);
  if (!journal?.isFile() || journal.size > 160) return;
  const expected = readFileSync(marker, 'utf8');
  if (!/^-?\d+(?::-?\d+){4}\n$/.test(expected) || statIfPresent(documentDirectory(root, key))) return;
  const file = path.join(root, key);
  const entry = statIfPresent(file, { bigint: true });
  if (entry && (!entry.isFile() || `${fingerprint(entry)}\n` !== expected)) return;
  if (referenced && !entry) return; // Missing bytes with a live row require inspection.
  if (!referenced && entry) unlinkSync(file);
  unlinkSync(marker);
}

export function prepareDocumentDeletion(uploadDir, storageKey) {
  if (typeof storageKey !== 'string' || !STORAGE_KEY.test(storageKey)) throw new NotFoundError('Document file not found');
  let root;
  if (typeof uploadDir === 'string') {
    const configuredRoot = path.resolve(uploadDir);
    const directory = statIfPresent(configuredRoot);
    if (!directory) return;
    if (!directory.isDirectory()) throw new Error('Invalid document storage directory');
    root = realpathSync(configuredRoot);
  } else {
    root = uploadDir.getPath();
  }
  const directory = documentDirectory(root, storageKey);
  const reservation = statIfPresent(directory);
  const legacy = statIfPresent(path.join(root, storageKey), { bigint: true });
  if (statIfPresent(path.join(root, `.${storageKey}.quarantine`))) throw new Error('Legacy quarantine requires manual recovery');
  if (reservation) {
    if (!reservation.isDirectory() || !hasMarker(directory) || legacy) throw new NotFoundError('Document file not found');
    const content = statIfPresent(path.join(directory, CONTENT));
    if (content && !content.isFile()) throw new NotFoundError('Document file not found');
    return (committed) => { if (committed) removeReservation(directory); };
  }
  if (!legacy) return;
  if (!legacy.isFile()) throw new NotFoundError('Document file not found');
  // Legacy flat files predate reserved directories. Journal their identity before changing SQLite.
  const marker = path.join(root, `.${storageKey}.delete`);
  writeFileSync(marker, `${fingerprint(legacy)}\n`, { flag: 'wx', mode: 0o600 });
  return (committed) => finishLegacyDelete(root, storageKey, marker, !committed);
}

export async function reconcileDocumentStorage(uploadDir, isReferenced) {
  let root;
  try {
    root = await storageRoot(uploadDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return;
  }
  const names = (await readdir(root)).sort();
  if (typeof uploadDir !== 'string') uploadDir.getPath();
  for (const name of names) {
    const match = RECOVERY_FILE.exec(name);
    if (!match || isReferenced(name)) continue;
    const [, key, kind] = match;
    const artifact = path.join(root, name);
    const referenced = isReferenced(key);
    if (kind === 'delete') {
      finishLegacyDelete(root, key, artifact, referenced);
    } else if (!referenced && statIfPresent(artifact)?.isDirectory() &&
               !statIfPresent(path.join(root, key)) &&
               !statIfPresent(path.join(root, `.${key}.delete`)) &&
               !statIfPresent(path.join(root, `.${key}.quarantine`))) {
      removeReservation(artifact);
    }
  }
}
