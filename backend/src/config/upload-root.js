import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const uid = process.getuid?.();
const androidAppData = /^\/data\/(?:data|user\/\d+)\/com\.termux(?=\/|$)/;

export function resolveAndroidUploadPath(configuredPath, resolveBase = realpathSync.native) {
  configuredPath = path.posix.resolve(configuredPath);
  const appData = androidAppData.exec(configuredPath)?.[0];
  if (!appData) throw new Error('UPLOAD_DIR must be inside private Android application storage');
  const base = resolveBase(appData);
  if (androidAppData.exec(base)?.[0] !== base) {
    throw new Error('UPLOAD_DIR must be inside private Android application storage');
  }
  return { base, root: path.posix.join(base, path.posix.relative(appData, configuredPath)) };
}

export function requireControlledDirectory(directory, stat, { isRoot, allowSticky, androidPrivate, androidFiles, owner = uid }) {
  if (!stat.isDirectory()) throw new Error(`Upload storage path is not a real directory: ${directory}`);
  if (owner === undefined) return; // Windows directory ownership and privacy are governed by ACLs.
  const trustedOwner = stat.uid === owner || (!isRoot && !androidPrivate && stat.uid === 0);
  if (!trustedOwner || (isRoot && (stat.mode & 0o077))) {
    throw new Error(`Upload storage path has unsafe ownership or permissions: ${directory}`);
  }
  const termuxWrapper = androidFiles && stat.gid === owner && (stat.mode & 0o777) === 0o771;
  if (!isRoot && (stat.mode & 0o022) && !termuxWrapper && !(allowSticky && stat.uid === 0 && (stat.mode & 0o1000))) {
    throw new Error(`Upload storage ancestor is writable by other users: ${directory}`);
  }
}

function checkStorageOperations(root) {
  const probe = mkdtempSync(path.join(root, '.startup-'));
  const source = path.join(probe, 'source');
  try {
    writeFileSync(source, '', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    throw new Error('Upload storage must support private directories and exclusive writes', { cause: err });
  } finally {
    rmSync(source, { force: true });
    rmdirSync(probe);
  }
}

export function prepareUploadRoot(uploadDir) {
  const configuredPath = path.resolve(uploadDir);
  let base = path.parse(configuredPath).root;
  let root = configuredPath;
  const android = process.platform === 'android' || (process.platform === 'linux' && Boolean(process.env.TERMUX_VERSION));
  if (android) {
    // Android may alias system paths above the app sandbox. Resolve only the trusted app-data prefix.
    ({ base, root } = resolveAndroidUploadPath(configuredPath));
  }
  if (root === base) throw new Error('UPLOAD_DIR must be a dedicated subdirectory');

  const directories = [base];
  for (const component of path.relative(base, root).split(path.sep)) {
    directories.push(path.join(directories.at(-1), component));
  }
  const pinned = directories.map((directory, index) => {
    const options = {
      isRoot: directory === root,
      androidPrivate: android,
      allowSticky: !android && index < directories.length - 2,
      androidFiles: android && directory === path.join(base, 'files'),
    };
    let stat;
    try {
      stat = lstatSync(directory);
    } catch (err) {
      if (err.code !== 'ENOENT' || index === 0) throw err;
      mkdirSync(directory, { mode: 0o700 });
      stat = lstatSync(directory);
    }
    requireControlledDirectory(directory, stat, options);
    return { directory, options, dev: stat.dev, ino: stat.ino };
  });

  const prepared = Object.freeze({
    getPath() {
      for (const { directory, options, dev, ino } of pinned) {
        const current = lstatSync(directory, { throwIfNoEntry: false });
        if (!current || current.dev !== dev || current.ino !== ino) {
          throw new Error(`Upload storage path changed after startup: ${directory}`);
        }
        requireControlledDirectory(directory, current, options);
      }
      return root;
    },
  });
  checkStorageOperations(prepared.getPath());
  return prepared;
}
