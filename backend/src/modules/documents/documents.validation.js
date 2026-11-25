import { once } from 'node:events';
import { open } from 'node:fs/promises';
import yauzl from 'yauzl';
import { FileUploadError } from '../../utils/errors.js';

export function invalidFile() {
  return new FileUploadError(415, 'UNSUPPORTED_DOCUMENT', 'File content does not match an allowed document type');
}

async function readAt(file, position, length) {
  const buffer = Buffer.alloc(length);
  for (let offset = 0; offset < length;) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw invalidFile();
    offset += bytesRead;
  }
  return buffer;
}

async function validatePdf(file, size) {
  const header = await readAt(file, 0, 9);
  if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]$/.test(header.toString('latin1'))) throw invalidFile();
  const tailStart = Math.max(9, size - 4096);
  const tail = (await readAt(file, tailStart, size - tailStart)).toString('latin1');
  const footer = /(?:^|[\r\n])startxref[\t ]*[\r\n]+[\t ]*(\d{1,10})[\t ]*[\r\n]+%%EOF[\t \r\n\f]*$/.exec(tail);
  if (!footer) throw invalidFile();
  const xref = Number(footer[1]);
  const footerStart = tailStart + footer.index;
  if (xref < 9 || xref >= footerStart) throw invalidFile();

  const target = (await readAt(file, xref, Math.min(4096, footerStart - xref))).toString('latin1');
  const table = /^xref\s+\d+\s+[1-9]\d*\s+\d{10} \d{5} [fn](?=\s)/.test(target);
  const streamStart = target.search(/\bstream[\r\n]/);
  const stream = streamStart >= 0 && /^\d+\s+\d+\s+obj\s*<</.test(target) &&
    /\/Type\s*\/XRef\b/.test(target.slice(0, streamStart));
  if (!table && !stream) throw invalidFile();
}

const pngDepths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);

function pngCrc(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function validatePng(file, size, signal) {
  const header = await readAt(file, 0, 33);
  const depth = header[24];
  const color = header[25];
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      header.readUInt32BE(8) !== 13 || header.toString('latin1', 12, 16) !== 'IHDR' ||
      !width || !height || width > 0x7fffffff || height > 0x7fffffff ||
      !pngDepths.get(color)?.includes(depth) || header[26] || header[27] || header[28] > 1 ||
      pngCrc(header.subarray(12, 29)) !== header.readUInt32BE(29)) throw invalidFile();

  let offset = header.length;
  let palette = false;
  let seenData = false;
  let dataEnded = false;
  let dataBytes = 0;
  const zlibHeader = [];
  for (let chunks = 0; chunks < 8192 && offset + 12 <= size; chunks += 1) {
    signal?.throwIfAborted();
    const chunk = await readAt(file, offset, 8);
    const length = chunk.readUInt32BE(0);
    const kind = chunk.toString('latin1', 4);
    const end = offset + 12 + length;
    if (end > size || !/^[A-Za-z]{4}$/.test(kind)) throw invalidFile();

    if (kind === 'IEND') {
      const crc = await readAt(file, offset + 8, 4);
      const [method, flags] = zlibHeader;
      if (length || end !== size || dataBytes < 8 || crc.readUInt32BE(0) !== 0xae426082 ||
          (method & 15) !== 8 || method >> 4 > 7 || (flags & 32) ||
          ((method << 8) | flags) % 31 !== 0) throw invalidFile();
      return;
    }
    if (kind === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) throw invalidFile();
      if (length && zlibHeader.length < 2) {
        zlibHeader.push(...await readAt(file, offset + 8, Math.min(length, 2 - zlibHeader.length)));
      }
      seenData = true;
      dataBytes += length;
    } else {
      if (seenData) dataEnded = true;
      if (kind === 'PLTE') {
        if (palette || seenData || color === 0 || color === 4 || !length || length % 3 ||
            length > 3 * (color === 3 ? 2 ** depth : 256)) throw invalidFile();
        palette = true;
      } else if (/^[A-Z]/.test(kind)) {
        throw invalidFile();
      }
    }
    offset = end;
  }
  throw invalidFile();
}

const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

async function validateJpeg(file, size, signal) {
  if (size < 4 || (await readAt(file, 0, 2)).readUInt16BE(0) !== 0xffd8 ||
      (await readAt(file, size - 2, 2)).readUInt16BE(0) !== 0xffd9) throw invalidFile();
  let offset = 2;
  let components;
  for (let markers = 0; markers < 4096 && offset + 4 <= size - 2; markers += 1) {
    signal?.throwIfAborted();
    const segment = await readAt(file, offset, 4);
    const marker = segment[1];
    if (segment[0] !== 0xff) throw invalidFile();
    if (marker === 0xff || marker === 0x01) {
      offset += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker < 0xc0 || (marker >= 0xd0 && marker <= 0xd9)) throw invalidFile();
    const length = segment.readUInt16BE(2);
    const end = offset + 2 + length;
    if (length < 2 || end > size - 2) throw invalidFile();
    if (frameMarkers.has(marker)) {
      if (length < 11) throw invalidFile();
      const frame = await readAt(file, offset + 4, length - 2);
      const count = frame[5];
      const ids = new Set();
      if (!count || length !== 8 + 3 * count || !frame.readUInt16BE(3) ||
          !frame.readUInt16BE(1) || frame[0] < 2 || frame[0] > 16) throw invalidFile();
      for (let i = 6; i < frame.length; i += 3) ids.add(frame[i]);
      if (ids.size !== count) throw invalidFile();
      components = ids;
    } else if (marker === 0xda) {
      if (!components || length < 8 || end >= size - 2) throw invalidFile();
      const scan = await readAt(file, offset + 4, length - 2);
      const count = scan[0];
      if (!count || count > 4 || length !== 6 + 2 * count) throw invalidFile();
      for (let i = 1; i <= 2 * count; i += 2) {
        if (!components.delete(scan[i])) throw invalidFile();
      }
      return; // Keep entropy-coded image data opaque.
    }
    offset = end;
  }
  throw invalidFile();
}

async function centralDirectory(file, size, count) {
  const length = Math.min(size, 65_557); // EOCD record plus the largest permitted ZIP comment.
  const start = size - length;
  const tail = await readAt(file, start, length);
  for (let i = length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== 0x06054b50 || i + 22 + tail.readUInt16LE(i + 20) !== length) continue;
    let trailerStart = start + i;
    let directorySize = tail.readUInt32LE(i + 12);
    let offset = tail.readUInt32LE(i + 16);
    if (tail.readUInt16LE(i + 4) || tail.readUInt16LE(i + 6)) throw invalidFile();
    const entries = tail.readUInt16LE(i + 10);
    if (entries === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff) {
      if (trailerStart < 20) throw invalidFile();
      const locator = await readAt(file, trailerStart - 20, 20);
      const recordOffset = Number(locator.readBigUInt64LE(8));
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) ||
          locator.readUInt32LE(16) !== 1 || recordOffset + 56 > trailerStart - 20) throw invalidFile();
      const record = await readAt(file, recordOffset, 56);
      if (record.readUInt32LE(0) !== 0x06064b50 || record.readUInt32LE(16) || record.readUInt32LE(20) ||
          recordOffset + 12 + Number(record.readBigUInt64LE(4)) !== trailerStart - 20 ||
          record.readBigUInt64LE(24) !== BigInt(count) || record.readBigUInt64LE(32) !== BigInt(count)) throw invalidFile();
      directorySize = Number(record.readBigUInt64LE(40));
      offset = Number(record.readBigUInt64LE(48));
      trailerStart = recordOffset;
    } else if (entries !== count || tail.readUInt16LE(i + 8) !== count) {
      throw invalidFile();
    }
    if (offset + directorySize !== trailerStart || (!count && offset)) throw invalidFile();
    return { offset, directorySize };
  }
  throw invalidFile();
}

async function descriptorEnd(file, position, directoryStart, entry, local) {
  const length = Math.min(24, directoryStart - position);
  const data = await readAt(file, position, length);
  const zip64 = local.compressedSize === 0xffffffff || local.uncompressedSize === 0xffffffff ||
    entry.uncompressedSize > 0xffffffff;
  for (const offset of [0, 4]) {
    const size = zip64 ? 20 : 12;
    if (length < offset + size || (offset && data.readUInt32LE(0) !== 0x08074b50) ||
        data.readUInt32LE(offset) !== entry.crc32) continue;
    const compressed = zip64 ? data.readBigUInt64LE(offset + 4) : BigInt(data.readUInt32LE(offset + 4));
    const uncompressed = zip64 ? data.readBigUInt64LE(offset + 12) : BigInt(data.readUInt32LE(offset + 8));
    if (compressed === BigInt(entry.compressedSize) && uncompressed === BigInt(entry.uncompressedSize)) {
      return position + offset + size;
    }
  }
  throw invalidFile();
}

async function validateArchive(file, filePath, size, extension, maxEntries, signal) {
  const magic = (await readAt(file, 0, 4)).readUInt32LE(0);
  if (magic !== 0x04034b50 && magic !== 0x06054b50) throw invalidFile();
  let archive;
  try {
    archive = await yauzl.openPromise(filePath, { autoClose: false, strictFileNames: true });
    signal?.throwIfAborted();
    if (archive.entryCount > maxEntries) {
      throw new FileUploadError(413, 'ARCHIVE_ENTRY_LIMIT', 'Document archive has too many entries');
    }
    const { offset, directorySize } = await centralDirectory(file, size, archive.entryCount);
    const required = new Map([['[content_types].xml', '[Content_Types].xml'], ['_rels/.rels', '_rels/.rels'],
      ['word/document.xml', 'word/document.xml']]);
    const names = new Set();
    const ranges = [];
    let directoryBytes = 0;
    // Read ZIP headers only. Never open an entry stream or inflate its contents.
    for await (const entry of archive.eachEntry()) {
      signal?.throwIfAborted();
      const local = await archive.readLocalFileHeaderPromise(entry);
      let end = local.fileDataStart + entry.compressedSize;
      if (!entry.fileName || entry.fileName.includes('\0') || end > offset ||
          !local.fileName.equals(entry.fileNameRaw) || local.compressionMethod !== entry.compressionMethod ||
          local.generalPurposeBitFlag !== entry.generalPurposeBitFlag) throw invalidFile();
      if (entry.generalPurposeBitFlag & 8) {
        end = await descriptorEnd(file, end, offset, entry, local);
      } else if (local.crc32 !== entry.crc32 ||
          (local.compressedSize !== 0xffffffff && local.compressedSize !== entry.compressedSize) ||
          (local.uncompressedSize !== 0xffffffff && local.uncompressedSize !== entry.uncompressedSize)) throw invalidFile();
      directoryBytes += 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
      ranges.push([entry.relativeOffsetOfLocalHeader, end]);

      if (extension === '.docx') {
        const name = entry.fileName.toLowerCase();
        if (names.has(name) || entry.isEncrypted()) throw invalidFile();
        names.add(name);
        if (required.has(name)) {
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (entry.fileName !== required.get(name) || !entry.uncompressedSize || !entry.compressedSize ||
              (entry.externalFileAttributes & 0x10) || (mode !== 0 && mode !== 0x8000) ||
              ![0, 8].includes(entry.compressionMethod)) throw invalidFile();
          required.delete(name);
        }
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    if (directoryBytes !== directorySize || (extension === '.docx' && required.size) ||
        ranges.some(([start], index) => index > 0 && start < ranges[index - 1][1])) throw invalidFile();
  } catch (err) {
    signal?.throwIfAborted();
    if (err.code) throw err;
    throw invalidFile();
  } finally {
    if (archive) {
      const closed = once(archive, 'close');
      archive.close();
      await closed;
    }
  }
}

export async function validateContents(filePath, extension, size, maxArchiveEntries, signal) {
  const file = await open(filePath, 'r');
  try {
    signal?.throwIfAborted();
    switch (extension) {
      case '.pdf': await validatePdf(file, size); break;
      case '.png': await validatePng(file, size, signal); break;
      case '.jpg':
      case '.jpeg': await validateJpeg(file, size, signal); break;
      default: await validateArchive(file, filePath, size, extension, maxArchiveEntries, signal);
    }
  } finally {
    await file.close();
  }
}
