import { getCourse, getCourseOrThrow, assertCanManageCourse } from '../courses/courses.service.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { newId } from '../../utils/ids.js';
import { openDocumentFile, prepareDocumentDeletion, reconcileDocumentStorage, storeDocumentFile } from './documents.storage.js';
import { DEFAULT_PAGE_SIZE } from './documents.schema.js';

const METADATA = 'id, course_id, uploaded_by, title, description, original_filename, file_size, mime_type, uploaded_at';

function documentReference(db) {
  const query = db.prepare('SELECT 1 FROM documents WHERE file_path = ? COLLATE NOCASE LIMIT 1');
  return (name) => Boolean(query.get(name));
}

function checkMetadata(db, user, { courseId, title, description = null }) {
  if (typeof title !== 'string' || !title.trim()) throw new ValidationError('Document title is required');
  if (description !== null && typeof description !== 'string') throw new ValidationError('Invalid document description');
  assertCanManageCourse(user, getCourseOrThrow(db, courseId));
  return { courseId, title: title.trim(), description };
}

export async function createDocument(db, uploadDir, user, { originalFilename, source, finishFields, signal, maxArchiveEntries, ...fields }) {
  let metadata = finishFields ? null : checkMetadata(db, user, fields);
  const id = newId();

  return storeDocumentFile(uploadDir, source, originalFilename, ({ storageKey, size, mimeType }) => {
    return db.transaction(() => {
      const { courseId, title, description } = metadata;
      assertCanManageCourse(user, getCourseOrThrow(db, courseId));
      return db.prepare(
        `INSERT INTO documents
         (id, course_id, uploaded_by, title, description, original_filename, file_path, file_size, mime_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${METADATA}`,
      ).get(id, courseId, user.sub, title, description, originalFilename, storageKey, size, mimeType);
    }).immediate();
  }, {
    signal,
    maxArchiveEntries,
    isReferenced: documentReference(db),
    finishUpload: finishFields && (async () => {
      metadata = checkMetadata(db, user, await finishFields());
    }),
  });
}

function getDocument(db, documentId) {
  const row = db.prepare(`SELECT ${METADATA}, file_path FROM documents WHERE id = ?`).get(documentId);
  if (!row) throw new NotFoundError('Document not found');
  return row;
}

export function updateDocument(db, user, documentId, changes) {
  return db.transaction(() => {
    const row = getDocument(db, documentId);
    assertCanManageCourse(user, getCourseOrThrow(db, row.course_id));
    const title = Object.hasOwn(changes, 'title') ? changes.title.trim() : row.title;
    const description = Object.hasOwn(changes, 'description') ? changes.description : row.description;
    return db.prepare(`UPDATE documents SET title = ?, description = ? WHERE id = ? RETURNING ${METADATA}`)
      .get(title, description, documentId);
  }).immediate();
}

export async function deleteDocument(db, uploadDir, user, documentId) {
  let finishDeletion;
  let sharedStorage;
  try {
    // No asynchronous gaps from the locked row lookup through commit or rollback.
    db.transaction(() => {
      const row = getDocument(db, documentId);
      assertCanManageCourse(user, getCourseOrThrow(db, row.course_id));
      finishDeletion = prepareDocumentDeletion(uploadDir, row.file_path);
      const { changes } = db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
      if (changes !== 1) throw new Error('Document deletion did not remove its row');
      sharedStorage = documentReference(db)(row.file_path);
    }).immediate();
  } catch (err) {
    try {
      finishDeletion?.(false);
    } catch (cleanupError) {
      throw new AggregateError([err, cleanupError], 'Document deletion journal cleanup failed');
    }
    throw err;
  }
  try {
    finishDeletion?.(!sharedStorage);
  } catch {
    // The row committed. Startup will finish removing the reservation or matching legacy file.
  }
  return { id: documentId };
}

export function reconcileDocuments(db, uploadDir) {
  return reconcileDocumentStorage(uploadDir, documentReference(db));
}

export function listDocuments(db, user, courseId, { page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
  getCourse(db, user, courseId);
  return db.prepare(
    `SELECT ${METADATA} FROM documents WHERE course_id = ? ORDER BY uploaded_at DESC, id LIMIT ? OFFSET ?`,
  ).all(courseId, limit + 1, (page - 1) * limit);
}

export async function readDocument(db, uploadDir, user, documentId) {
  const row = getDocument(db, documentId);
  getCourse(db, user, row.course_id);
  const { file_path: storageKey, ...metadata } = row;
  return { metadata, ...await openDocumentFile(uploadDir, storageKey) };
}
