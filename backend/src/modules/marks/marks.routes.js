import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { ValidationError } from '../../utils/errors.js';
import { ok } from '../../utils/response.js';
import { UUID_PATTERN } from '../../utils/validation.js';
import { createAssessment, listAssessmentMarks, listAssessments, saveStudentMark } from './marks.service.js';

const teacherOnly = [authenticate, authorize('teacher')];
const teacherOrStudent = [authenticate, authorize('teacher', 'student')];
const uuid = { type: 'string', pattern: UUID_PATTERN };
const course = { courseId: uuid };
const assessment = { ...course, assessmentId: uuid };

function requiredObject(properties) {
  return { type: 'object', required: Object.keys(properties), properties, additionalProperties: false };
}

function requireNumber(field) {
  return async (request) => {
    if (!Number.isFinite(request.body?.[field])) throw new ValidationError('Enter a numeric score or maximum.');
  };
}

export default async function marksRoutes(app) {
  const base = '/api/courses/:courseId/assessments';
  app.get(base, {
    onRequest: teacherOrStudent,
    schema: { params: requiredObject(course) },
  }, (request) => ok(listAssessments(app.db, request.user, request.params.courseId)));

  app.post(base, {
    onRequest: teacherOnly,
    preValidation: requireNumber('max_marks'),
    schema: {
      params: requiredObject(course),
      body: requiredObject({
        title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
        max_marks: { type: 'number', exclusiveMinimum: 0 },
      }),
    },
  }, (request, reply) => {
    const result = createAssessment(app.db, request.user, request.params.courseId, request.body);
    return reply.code(201).send(ok(result));
  });

  app.get(base + '/:assessmentId/marks', {
    onRequest: teacherOnly,
    schema: { params: requiredObject(assessment) },
  }, (request) => {
    const { courseId, assessmentId } = request.params;
    return ok(listAssessmentMarks(app.db, request.user, courseId, assessmentId));
  });

  app.put(base + '/:assessmentId/marks/:studentId', {
    onRequest: teacherOnly,
    preValidation: requireNumber('marks_obtained'),
    schema: {
      params: requiredObject({ ...assessment, studentId: uuid }),
      body: requiredObject({ marks_obtained: { type: 'number', minimum: 0 } }),
    },
  }, (request) => {
    const { courseId, assessmentId, studentId } = request.params;
    return ok(saveStudentMark(app.db, request.user, courseId, assessmentId, studentId, request.body.marks_obtained));
  });
}
