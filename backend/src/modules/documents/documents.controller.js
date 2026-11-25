import { AppError, FileUploadError, ValidationError } from '../../utils/errors.js';
import { ok } from '../../utils/response.js';
import { UUID_PATTERN } from '../../utils/validation.js';
import { assertCanManageCourse, getCourseOrThrow } from '../courses/courses.service.js';
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from './documents.schema.js';
import * as documents from './documents.service.js';

const courseIdPattern = new RegExp(UUID_PATTERN);
const downloadTypes = new Set([
  'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png', 'image/jpeg', 'application/zip',
]);

function addUploadField(fields, part, db, user) {
  const { fieldname, value, fieldnameTruncated, valueTruncated } = part;
  if (fieldnameTruncated || valueTruncated || Object.hasOwn(fields, fieldname) || typeof value !== 'string') {
    throw new ValidationError('Invalid or duplicate upload field');
  }
  switch (fieldname) {
    case 'courseId':
      if (!courseIdPattern.test(value)) throw new ValidationError('Invalid courseId');
      assertCanManageCourse(user, getCourseOrThrow(db, value));
      break;
    case 'title':
      if (!value.trim() || value.length > MAX_TITLE_LENGTH) throw new ValidationError('Invalid document title');
      break;
    case 'description':
      if (value.length > MAX_DESCRIPTION_LENGTH) throw new ValidationError('Invalid document description');
      break;
    default:
      throw new ValidationError('Unexpected upload field');
  }
  fields[fieldname] = value;
}

export async function upload(request, reply, signal) {
  if (!request.isMultipart()) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected multipart/form-data');
  const { db, config } = request.server;
  const parts = request.parts();
  const fields = {};
  const stopped = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  async function nextPart() {
    signal.throwIfAborted();
    const next = await Promise.race([parts.next(), stopped]);
    signal.throwIfAborted();
    return next;
  }
  let source;
  try {
    for (let next = await nextPart(); !next.done; next = await nextPart()) {
      const part = next.value;
      if (part.type === 'field') {
        addUploadField(fields, part, db, request.user);
        continue;
      }
      source = part.file;
      // Record parser errors as stream failures even while storage is opening its staging file.
      source.once('error', (err) => source.destroy(err));
      const tooLarge = () => new FileUploadError(413, 'PAYLOAD_TOO_LARGE', 'Document exceeds 50 MiB');
      source.once('limit', () => source.destroy(tooLarge()));
      if (source.truncated) throw tooLarge();
      if (part.fieldname !== 'file' || !part.filename) throw new ValidationError('Expected a file part named file');
      const metadata = await documents.createDocument(db, config.uploadDir, request.user, {
        originalFilename: part.filename,
        source,
        signal,
        maxArchiveEntries: config.documentArchiveMaxEntries,
        async finishFields() {
          for (let next = await nextPart(); !next.done; next = await nextPart()) {
            const trailing = next.value;
            if (trailing.type !== 'field') {
              trailing.file.resume();
              throw new ValidationError('Only one document file is allowed');
            }
            addUploadField(fields, trailing, db, request.user);
          }
          if (!fields.courseId || !fields.title) throw new ValidationError('courseId and title are required');
          return fields;
        },
      });
      return reply.code(201).send(ok(metadata));
    }
    throw new ValidationError('A document file is required');
  } catch (err) {
    source?.destroy();
    signal.throwIfAborted();
    // Busboy emits plain parser errors for malformed boundaries and incomplete bodies.
    if (/boundary|multipart|terminated early|premature close/i.test(err.message) &&
        (!err.code || err.code === 'ERR_STREAM_PREMATURE_CLOSE')) {
      throw new ValidationError('Malformed multipart upload');
    }
    throw err;
  }
}

export function list(request, reply) {
  const { courseId, page, limit } = request.query;
  const rows = documents.listDocuments(request.server.db, request.user, courseId, { page, limit });
  if (rows.length > limit) {
    rows.pop();
    reply.header('X-Next-Page', page + 1);
  }
  return ok(rows);
}

export function update(request) {
  return ok(documents.updateDocument(request.server.db, request.user, request.params.documentId, request.body));
}

export async function remove(request, reply) {
  const { db, config } = request.server;
  await documents.deleteDocument(db, config.uploadDir, request.user, request.params.documentId);
  return reply.code(204).send();
}

function attachmentName(originalFilename) {
  const filename = originalFilename?.replace(/[\\/\x00-\x1f\x7f]/g, '_') || 'document';
  const fallback = filename.replace(/[^\w .-]/g, '_');
  const encoded = encodeURIComponent(Buffer.from(filename).toString()).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function download(request, reply) {
  const { db, config } = request.server;
  const { metadata, stream, size } = await documents.readDocument(db, config.uploadDir, request.user, request.params.documentId);
  return reply
    .type(downloadTypes.has(metadata.mime_type) ? metadata.mime_type : 'application/octet-stream')
    .header('Content-Disposition', attachmentName(metadata.original_filename))
    .header('Content-Length', size)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private, no-store')
    .send(stream);
}
