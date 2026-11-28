import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { marksApi, type Assessment, type AssessmentStudent } from '../marks';
import { api } from '../services';
import { Empty, ErrorText, PageTitle, Result } from '../ui';

function ScoreEditor({ course, assessment, student }: {
  course: string;
  assessment: Assessment;
  student: AssessmentStudent;
}) {
  const client = useQueryClient();
  const queryKey = ['marks', course, assessment.id];
  const save = useMutation({
    mutationFn: (score: number) => marksApi.save(course, assessment.id, student.student_id, score),
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });

  return (
    <li>
      <span>
        <strong>{student.full_name}</strong>
        <small>{student.email}</small>
        <small>{student.marks_obtained === null ? 'Ungraded' : `${student.marks_obtained} / ${assessment.max_marks}`}</small>
      </span>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          const score = new FormData(event.currentTarget).get('score');
          if (typeof score === 'string' && score.trim() && !save.isPending) save.mutate(Number(score));
        }}
      >
        <label>
          Score for {student.full_name}
          <input
            name="score"
            type="number"
            required
            min={0}
            max={assessment.max_marks}
            step="any"
            defaultValue={student.marks_obtained ?? ''}
            disabled={save.isPending}
            onChange={() => save.reset()}
          />
        </label>
        <button disabled={save.isPending}>Save score</button>
        <ErrorText error={save.error} />
        {save.isSuccess && <small role="status">Score saved.</small>}
      </form>
    </li>
  );
}

function AssessmentRoster({ course, assessment }: { course: string; assessment: Assessment }) {
  const roster = useQuery({
    queryKey: ['marks', course, assessment.id],
    queryFn: () => marksApi.roster(course, assessment.id),
  });
  return (
    <section className="card">
      <h2>{assessment.title} ({assessment.max_marks} points)</h2>
      <Result query={roster}>
        {(students) => students.length ? (
          <ul className="rows">
            {students.map((student) => (
              <ScoreEditor key={student.student_id} course={course} assessment={assessment} student={student} />
            ))}
          </ul>
        ) : <Empty>No students are enrolled in this course.</Empty>}
      </Result>
    </section>
  );
}

function CourseMarks({ course, teacher }: { course: string; teacher: boolean }) {
  const client = useQueryClient();
  const [selected, setSelected] = useState('');
  const queryKey = ['marks', course];
  const assessments = useQuery({ queryKey, queryFn: () => marksApi.assessments(course) });
  const create = useMutation({
    mutationFn: (fields: Pick<Assessment, 'title' | 'max_marks'>) => marksApi.create(course, fields),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey });
      setSelected(created.id);
    },
  });

  return (
    <>
      {teacher && (
        <form className="card form-stack" onSubmit={(event) => {
          event.preventDefault();
          if (create.isPending) return;
          const form = event.currentTarget;
          const fields = new FormData(form);
          const title = String(fields.get('title')).trim();
          const maximum = String(fields.get('maximum')).trim();
          if (!title || !maximum) return;
          create.mutate({ title, max_marks: Number(maximum) }, { onSuccess: () => form.reset() });
        }}>
          <h2>Create assessment</h2>
          <label>Assessment title<input name="title" required maxLength={200} pattern=".*\S.*" title="Enter an assessment title with at least one non-space character." /></label>
          <label>
            Maximum score
            <input
              name="maximum" type="number" step="any" min={0} required
              onChange={({ currentTarget }) => currentTarget.setCustomValidity(
                currentTarget.valueAsNumber <= 0 ? 'Enter a maximum score greater than zero.' : '',
              )}
            />
          </label>
          <ErrorText error={create.error} />
          <div><button className="primary" disabled={create.isPending}>Create assessment</button></div>
        </form>
      )}
      <Result query={assessments}>
        {(items) => {
          if (!items.length) return <section className="card"><Empty>No assessments yet.</Empty></section>;
          if (!teacher) {
            return (
              <section className="card">
                <h2>Your results</h2>
                <ul className="rows">
                  {items.map((item) => (
                    <li key={item.id}>
                      <strong>{item.title}</strong>
                      <span>{item.marks_obtained === null ? 'Ungraded' : `${item.marks_obtained} / ${item.max_marks}`}</span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          }
          const assessment = items.find((item) => item.id === selected) ?? items[0];
          return (
            <>
              <label className="filter">
                Assessment
                <select value={assessment.id} onChange={(event) => setSelected(event.target.value)}>
                  {items.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                </select>
              </label>
              <AssessmentRoster key={assessment.id} course={course} assessment={assessment} />
            </>
          );
        }}
      </Result>
    </>
  );
}

export default function Marks({ teacher }: { teacher: boolean }) {
  const [selected, setSelected] = useState('');
  const courses = useQuery({ queryKey: ['marks', 'courses', teacher], queryFn: () => api.courses(!teacher) });
  return (
    <>
      <PageTitle
        label={teacher ? 'Teacher workspace' : 'Student workspace'}
        title="Marks"
        detail={teacher ? 'Create assessments and record scores for your courses.' : 'View your assessment results by course.'}
      />
      <Result query={courses}>
        {(items) => {
          if (!items.length) return <section className="card"><Empty>No courses yet.</Empty></section>;
          const course = items.find((item) => item.id === selected) ?? items[0];
          return (
            <>
              <label className="filter">
                Course
                <select value={course.id} onChange={(event) => setSelected(event.target.value)}>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>{item.course_code} · {item.title}</option>
                  ))}
                </select>
              </label>
              <CourseMarks key={course.id} course={course.id} teacher={teacher} />
            </>
          );
        }}
      </Result>
    </>
  );
}
