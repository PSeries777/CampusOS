import { http } from './api';
import type { Student } from './types';

export interface Assessment {
  id: string;
  title: string;
  max_marks: number;
  marks_obtained: number | null;
}

export interface AssessmentStudent extends Student {
  marks_obtained: number | null;
}

const assessmentsPath = (course: string) => '/courses/' + encodeURIComponent(course) + '/assessments';
const marksPath = (course: string, assessment: string) =>
  assessmentsPath(course) + '/' + encodeURIComponent(assessment) + '/marks';

export const marksApi = {
  assessments: (course: string) => http<Assessment[]>(assessmentsPath(course)),
  create: (course: string, fields: Pick<Assessment, 'title' | 'max_marks'>) =>
    http<Assessment>(assessmentsPath(course), 'POST', fields),
  roster: (course: string, assessment: string) =>
    http<AssessmentStudent[]>(marksPath(course, assessment)),
  save: (course: string, assessment: string, student: string, marks_obtained: number) =>
    http<Pick<AssessmentStudent, 'student_id' | 'marks_obtained'>>(
      marksPath(course, assessment) + '/' + encodeURIComponent(student), 'PUT', { marks_obtained },
    ),
};
