import Fastify from 'fastify';
import { createErrorHandler, notFoundHandler } from './utils/errors.js';
import healthRoutes from './modules/health/health.routes.js';
import { registerJwt } from './plugins/jwt.js';
import authRoutes from './modules/auth/auth.routes.js';
import attendanceRoutes from './modules/attendance/attendance.routes.js';
import courseRoutes from './modules/courses/courses.routes.js';
import enrollmentRoutes from './modules/enrollments/enrollments.routes.js';
import documentRoutes from './modules/documents/documents.routes.js';

/**
 * Builds the Fastify instance. Config and db are injected (not imported) so tests
 * can run against a temporary database without touching real environment variables.
 */
export function buildApp({ config, db }) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    disableRequestLogging: config.isProduction,
  });

  app.decorate('db', db);
  app.decorate('config', config);

  app.setErrorHandler(createErrorHandler(config));
  app.setNotFoundHandler(notFoundHandler);

  app.register(healthRoutes);

  // Auth-dependent modules need a JWT secret. env.js always supplies one (and rejects weak
  // ones in production); only a hand-built config without a secret (e.g. Phase 1 schema tests)
  // skips them. Fails closed: the protected routes simply do not exist without a secret.
  if (config.jwtSecret) {
    registerJwt(app, config);
    app.register(authRoutes);
    app.register(attendanceRoutes);
    app.register(courseRoutes);
    app.register(enrollmentRoutes);
    app.register(documentRoutes);
  } else {
    app.log.warn('jwtSecret not configured: auth and protected routes are disabled');
  }

  return app;
}
