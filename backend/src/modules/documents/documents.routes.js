import multipart from '@fastify/multipart';
import { documentDefaults } from '../../config/documents.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { AppError, createErrorHandler } from '../../utils/errors.js';
import * as controller from './documents.controller.js';
import { documentIdSchema, documentListSchema, documentUpdateSchema } from './documents.schema.js';
import { MAX_DOCUMENT_BYTES } from './documents.storage.js';

const anyUser = [authenticate];
const staffOnly = [authenticate, authorize('teacher', 'admin')];

export default async function documentRoutes(app) {
  const {
    documentUploadConcurrency = documentDefaults.documentUploadConcurrency,
    documentUploadTimeoutMs = documentDefaults.documentUploadTimeoutMs,
  } = app.config;
  let activeUploads = 0;
  await app.register(multipart, {
    preservePath: true,
    limits: {
      fileSize: MAX_DOCUMENT_BYTES,
      fieldNameSize: 32,
      fieldSize: 4000,
      fields: 3,
      files: 1,
      parts: 4,
      headerPairs: 16,
    },
  });
  // Use the existing error envelope and suppress internal paths in every environment.
  app.setErrorHandler(createErrorHandler({ isProduction: true }));

  app.post('/api/documents', { onRequest: staffOnly }, async (request, reply) => {
    if (activeUploads >= documentUploadConcurrency) {
      if (!request.raw.readableEnded) reply.header('Connection', 'close');
      reply.header('Retry-After', '1');
      throw new AppError(429, 'UPLOAD_BUSY', 'Too many concurrent document uploads');
    }

    activeUploads += 1;
    const cancellation = new AbortController();
    const timer = setTimeout(() => {
      cancellation.abort(new AppError(408, 'UPLOAD_TIMEOUT', 'Document upload timed out'));
    }, documentUploadTimeoutMs);
    timer.unref();
    const onResponseClose = () => {
      if (!reply.raw.writableFinished) {
        cancellation.abort(new AppError(400, 'INCOMPLETE_UPLOAD', 'Document upload ended early'));
      }
    };
    reply.raw.once('close', onResponseClose);
    try {
      return await controller.upload(request, reply, cancellation.signal);
    } catch (err) {
      if (!request.raw.readableEnded) {
        request.raw.unpipe();
        reply.header('Connection', 'close');
      }
      throw err;
    } finally {
      clearTimeout(timer);
      reply.raw.removeListener('close', onResponseClose);
      activeUploads -= 1;
    }
  });
  app.get('/api/documents', { onRequest: anyUser, schema: documentListSchema }, controller.list);
  app.patch('/api/documents/:documentId', {
    onRequest: staffOnly,
    schema: documentUpdateSchema,
    preValidation(request, reply, done) {
      const body = request.body;
      if (body && Object.entries(body).some(([key, value]) =>
        !['title', 'description'].includes(key) ||
        (typeof value !== 'string' && !(key === 'description' && value === null)))) {
        return done(new AppError(400, 'VALIDATION_ERROR', 'Invalid document metadata'));
      }
      done();
    },
  }, controller.update);
  app.delete('/api/documents/:documentId', { onRequest: staffOnly, schema: documentIdSchema }, controller.remove);
  app.get('/api/documents/:documentId/download', { onRequest: anyUser, schema: documentIdSchema }, controller.download);
}
