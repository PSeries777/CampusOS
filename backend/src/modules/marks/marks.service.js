import { newId } from '../../utils/ids.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { getCourse } from '../courses/courses.service.js';

export function listAssessments(db, user, courseId) {
  getCourse(db, user, courseId);
  return db.prepare(
    `SELECT a.id, a.title, a.max_marks, m.marks_obtained
       FROM assessments a
       LEFT JOIN student_marks m ON m.assessment_id = a.id AND m.student_id = ?
      WHERE a.course_id = ?
      ORDER BY a.created_at, a.id`,
  ).all(user.role === 'student' ? user.sub : null, courseId);
}

export function createAssessment(db, user, courseId, { title, max_marks }) {
  const name = title.trim();
  if (!name) throw new ValidationError('Enter an assessment title.');
  const assessment = { id: newId(), title: name, max_marks, marks_obtained: null };
  return db.transaction(() => {
    getCourse(db, user, courseId);
    // Weight stays unset for individual results until weighted grades are supported.
    db.prepare('INSERT INTO assessments (id, course_id, title, max_marks, weightage) VALUES (?, ?, ?, ?, 0)')
      .run(assessment.id, courseId, name, max_marks);
    return assessment;
  }).immediate();
}

function getAssessment(db, user, courseId, assessmentId) {
  getCourse(db, user, courseId);
  const assessment = db.prepare('SELECT max_marks FROM assessments WHERE id = ? AND course_id = ?')
    .get(assessmentId, courseId);
  if (!assessment) throw new NotFoundError('Assessment not found');
  return assessment;
}

export function listAssessmentMarks(db, user, courseId, assessmentId) {
  getAssessment(db, user, courseId, assessmentId);
  return db.prepare(
    `SELECT e.student_id, u.full_name, u.email, m.marks_obtained
       FROM enrollments e
       JOIN users u ON u.id = e.student_id
       LEFT JOIN student_marks m ON m.student_id = e.student_id AND m.assessment_id = ?
      WHERE e.course_id = ?
      ORDER BY u.full_name COLLATE NOCASE, e.student_id`,
  ).all(assessmentId, courseId);
}

export function saveStudentMark(db, user, courseId, assessmentId, studentId, score) {
  return db.transaction(() => {
    const { max_marks } = getAssessment(db, user, courseId, assessmentId);
    if (score > max_marks) throw new ValidationError('The score cannot exceed the assessment maximum.');
    const enrolled = db.prepare('SELECT 1 FROM enrollments WHERE course_id = ? AND student_id = ?')
      .get(courseId, studentId);
    if (!enrolled) throw new NotFoundError('Student is not enrolled in this course.');
    db.prepare(
      `INSERT INTO student_marks (assessment_id, student_id, marks_obtained) VALUES (?, ?, ?)
       ON CONFLICT (assessment_id, student_id) DO UPDATE SET
         marks_obtained = excluded.marks_obtained,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run(assessmentId, studentId, score);
    return { student_id: studentId, marks_obtained: score };
  }).immediate();
}
