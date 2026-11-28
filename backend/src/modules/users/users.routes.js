import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { ok } from '../../utils/response.js';
import { createUser, listUsers } from './users.service.js';

const adminOnly = [authenticate, authorize('admin')];
const createUserSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['full_name', 'email', 'password', 'role'],
    properties: {
      full_name: { type: 'string', minLength: 1, maxLength: 120 },
      email: { type: 'string', minLength: 3, maxLength: 254 },
      password: { type: 'string', minLength: 12, maxLength: 72 },
      role: { type: 'string', enum: ['teacher', 'student'] },
    },
  },
};

export default async function usersRoutes(app) {
  app.get('/api/users', { onRequest: adminOnly }, async (request) =>
    ok(listUsers(request.server.db)),
  );
  app.post('/api/users', { onRequest: adminOnly, schema: createUserSchema }, async (request, reply) => {
    const user = await createUser(request.server.db, request.body);
    return reply.code(201).send(ok(user));
  });
}
