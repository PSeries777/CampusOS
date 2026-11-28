import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, BookOpen, Plus } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, useMocks } from '../services';
import { usersApi, usersQueryKey } from '../users';
import { dateTime } from '../attendance';
import type { Course, SessionDetail, User } from '../types';
import { Empty, ErrorText, PageTitle, Result } from '../ui';
import {
  MIN_STUDENT_SEARCH_LENGTH,
  useStudentSearch,
} from '../useStudentSearch';

function CourseEditor({
  course,
  admin,
  close,
}: {
  course?: Course;
  admin: boolean;
  close: () => void;
}) {
  const client = useQueryClient();
  const users = useQuery({
    queryKey: usersQueryKey,
    queryFn: usersApi.list,
    enabled: admin && !useMocks,
  });
  const teachers = users.data?.filter((user) => user.role === 'teacher') ?? [];
  const save = useMutation({
    mutationFn: (form: FormData) =>
      api.saveCourse(
        {
          course_code: String(form.get('code')).trim(),
          title: String(form.get('title')).trim(),
          ...(admin ? { teacher_id: String(form.get('teacher')).trim() } : {}),
        },
        course?.id,
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['staff', 'courses'] });
      close();
    },
  });
  return (
    <form
      className="card form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(new FormData(e.currentTarget));
      }}
    >
      <h2>{course ? 'Edit course' : 'Create course'}</h2>
      <label>
        Course code
        <input
          name="code"
          required
          maxLength={32}
          defaultValue={course?.course_code}
        />
      </label>
      <label>
        Title
        <input
          name="title"
          required
          maxLength={200}
          defaultValue={course?.title}
        />
      </label>
      {admin && (useMocks ? (
        <label>
          Teacher ID
          <input name="teacher" required defaultValue={course?.teacher_id} />
        </label>
      ) : (
        <Result query={users}>
          {() => teachers.length ? (
            <label>
              Teacher
              <select name="teacher" required defaultValue={course?.teacher_id ?? ''}>
                <option value="">Choose a teacher</option>
                {teachers.map((teacher) => (
                  <option key={teacher.id} value={teacher.id}>
                    {teacher.full_name} ({teacher.email})
                  </option>
                ))}
              </select>
            </label>
          ) : <p className="quiet">Create a teacher account under Users first.</p>}
        </Result>
      ))}
      <ErrorText error={save.error} />
      <div className="inline">
        <button className="primary" disabled={save.isPending || (admin && !useMocks && !teachers.length)}>
          {save.isPending ? 'Saving…' : 'Save course'}
        </button>
        <button type="button" onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}
function Roster({ course }: { course: Course }) {
  const client = useQueryClient();
  const [student, setStudent] = useState('');
  const [term, setTerm] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const search = useStudentSearch(course.id, term);
  const matches =
    search.eligible && !search.isDebouncing ? (search.query.data ?? []) : [];
  const selected = matches.find(
    (student) => student.student_id === selectedId && !student.already_enrolled,
  );
  const queryKey = ['staff', 'roster', course.id];
  const roster = useQuery({ queryKey, queryFn: () => api.roster(course.id) });
  const change = useMutation({
    mutationFn: ({ id, remove }: { id: string; remove: boolean }) =>
      remove ? api.unenroll(course.id, id) : api.enroll(course.id, id),
    onSuccess: async (_, action) => {
      if (!action.remove) {
        setStudent('');
        setSelectedId('');
      }
      await client.invalidateQueries({ queryKey: ['staff'] });
    },
  });
  const manualEnroll = (
    <form
      className="enroll"
      onSubmit={(event) => {
        event.preventDefault();
        if (student.trim() && !change.isPending)
          change.mutate({ id: student.trim(), remove: false });
      }}
    >
      <label>
        Student ID
        <input
          value={student}
          onChange={(event) => setStudent(event.target.value)}
          placeholder="Student UUID"
          required
        />
      </label>
      <button
        className={useMocks ? 'primary' : undefined}
        disabled={change.isPending}
      >
        {useMocks ? 'Enroll student' : 'Enroll by ID'}
      </button>
    </form>
  );
  return (
    <section className="card">
      <h2>Course roster</h2>
      {!useMocks && (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (selected && !change.isPending)
              change.mutate({ id: selected.student_id, remove: false });
          }}
        >
          <label>
            Find a student
            <input
              type="search"
              value={term}
              maxLength={254}
              autoComplete="off"
              placeholder="Name or email"
              onChange={(event) => {
                setTerm(event.target.value);
                setSelectedId('');
                change.reset();
              }}
              disabled={change.isPending}
            />
          </label>
          {!search.eligible && (
            <p className="quiet">
              Enter at least {MIN_STUDENT_SEARCH_LENGTH} characters.
            </p>
          )}
          {search.eligible &&
            (search.isDebouncing || search.query.isFetching) && (
              <p className="quiet" role="status">
                Searching for students…
              </p>
            )}
          {search.eligible && !search.isDebouncing && search.query.isError && (
            <div>
              <ErrorText error={search.query.error} />
              <button
                type="button"
                disabled={search.query.isFetching}
                onClick={() => void search.query.refetch()}
              >
                Retry search
              </button>
            </div>
          )}
          {search.eligible &&
            !search.isDebouncing &&
            search.query.isSuccess &&
            !search.query.data.length && (
              <p className="quiet" role="status">
                No matching students.
              </p>
            )}
          {matches.length > 0 && (
            <fieldset
              className="student-search-results"
              disabled={change.isPending}
            >
              <legend>Search results</legend>
              <ul className="rows">
                {matches.map((match) => (
                  <li key={match.student_id}>
                    <label>
                      <input
                        type="radio"
                        name="student-search-result"
                        checked={selectedId === match.student_id}
                        disabled={match.already_enrolled}
                        onChange={() => {
                          setSelectedId(match.student_id);
                          change.reset();
                        }}
                      />
                      <span>
                        <strong>{match.full_name}</strong>
                        <small>{match.email}</small>
                        {match.already_enrolled && (
                          <small>Already enrolled</small>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          <div>
            <button
              className="primary"
              disabled={!selected || change.isPending}
            >
              Enroll student
            </button>
          </div>
        </form>
      )}
      {useMocks ? (
        manualEnroll
      ) : (
        <details className="manual-enrollment">
          <summary>Enroll by student ID</summary>
          {manualEnroll}
        </details>
      )}
      <ErrorText error={change.error} />
      <Result query={roster}>
        {(items) =>
          items.length ? (
            <ul className="rows">
              {items.map((item) => (
                <li key={item.student_id}>
                  <span>
                    <strong>{item.full_name}</strong>
                    <small>{item.email}</small>
                  </span>
                  <button
                    disabled={change.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          'Remove ' + item.full_name + ' from this course?',
                        )
                      )
                        change.mutate({ id: item.student_id, remove: true });
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quiet">No students enrolled.</p>
          )
        }
      </Result>
    </section>
  );
}
function SessionPanel({
  detail,
  busy,
  stop,
  update,
}: {
  detail: SessionDetail;
  busy: boolean;
  stop: () => void;
  update: (id: string, present: boolean) => void;
}) {
  return (
    <>
      <section className="card glass session-code">
        <div className="spread">
          <span
            className={'badge ' + (detail.session.is_active ? 'excellent' : '')}
          >
            {detail.session.is_active ? 'Live session' : 'Closed session'}
          </span>
          <small>{dateTime(detail.session.started_at)}</small>
        </div>
        {detail.session.is_active ? (
          <>
            <div className="attendance-summary">
              <div className="attendance-stat">
                <h2>Session code</h2>
                <strong className="big-code">{detail.session.otp_code}</strong>
              </div>
              <div
                className="attendance-stat attendance-present"
                aria-live="polite"
                aria-atomic="true"
              >
                <h2>Students present</h2>
                <strong className="big-code">{detail.present.length}</strong>
              </div>
            </div>
            <p>Share this code with students to record their attendance.</p>
            <button
              disabled={busy}
              onClick={() => {
                if (window.confirm('End this attendance session?')) stop();
              }}
            >
              End session
            </button>
          </>
        ) : (
          <h2>Session results</h2>
        )}
      </section>
      <div className="grid two">
        <section className="card">
          <h2>Present · {detail.present.length}</h2>
          {detail.present.length ? (
            <ul className="rows">
              {detail.present.map((student) => (
                <li key={student.student_id}>
                  <span>
                    <strong>{student.full_name}</strong>
                    <small>
                      {student.manual ? 'Manual · ' : ''}
                      {dateTime(student.punched_at)}
                    </small>
                  </span>
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          'Remove the attendance record for ' +
                            student.full_name +
                            '?',
                        )
                      )
                        update(student.student_id, false);
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quiet">No attendance recorded yet.</p>
          )}
        </section>
        <section className="card">
          <h2>Absent · {detail.absent.length}</h2>
          {detail.absent.length ? (
            <ul className="rows">
              {detail.absent.map((student) => (
                <li key={student.student_id}>
                  <span>
                    <strong>{student.full_name}</strong>
                    <small>{student.email}</small>
                  </span>
                  <button
                    disabled={busy}
                    onClick={() => update(student.student_id, true)}
                  >
                    Mark present
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quiet">No absent students.</p>
          )}
        </section>
      </div>
    </>
  );
}
function Sessions({ course }: { course: Course }) {
  const [selected, setSelected] = useState('');
  const client = useQueryClient();
  const sessions = useQuery({
    queryKey: ['staff', 'sessions', course.id],
    queryFn: () => api.sessions(course.id),
    refetchInterval: 4000,
  });
  const current = sessions.data?.find((item) => item.is_active);
  const id = selected || current?.id || '';
  const detail = useQuery({
    queryKey: ['staff', 'session', id],
    queryFn: () => api.session(id),
    enabled: Boolean(id),
    refetchInterval: 4000,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['staff'] });
  const start = useMutation({
    mutationFn: () => api.start(course.id),
    onSuccess: async (session) => {
      setSelected(session.id);
      await refresh();
    },
    onError: refresh,
  });
  const stop = useMutation({
    mutationFn: () => api.stop(id),
    onSuccess: async (session) => {
      setSelected(session.id);
      await refresh();
    },
  });
  const change = useMutation({
    mutationFn: ({
      student,
      present,
    }: {
      student: string;
      present: boolean;
    }) => (present ? api.mark(id, student) : api.unmark(id, student)),
    onSuccess: refresh,
  });
  const busy = start.isPending || stop.isPending || change.isPending;
  return (
    <>
      <div className="spread">
        <h2>{course.course_code} attendance</h2>
        <button
          className="primary"
          disabled={busy || !!current || !sessions.isSuccess}
          onClick={() => start.mutate()}
        >
          <Activity size={16} /> Start session
        </button>
      </div>
      <ErrorText error={start.error ?? stop.error ?? change.error} />
      <Result query={sessions}>
        {(items) =>
          items.length ? (
            <label className="filter">
              Session
              <select
                value={id}
                onChange={(e) => {
                  setSelected(e.target.value);
                  stop.reset();
                  change.reset();
                }}
              >
                {!id && <option value="">Choose a session</option>}
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.is_active ? 'Live' : 'Closed'} ·{' '}
                    {dateTime(item.started_at)} · {item.attendance_count ?? 0}{' '}
                    present
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <Empty>Start a session to record attendance for this course.</Empty>
          )
        }
      </Result>
      {id && (
        <Result query={detail}>
          {(data) => (
            <SessionPanel
              detail={data}
              busy={busy}
              stop={() => stop.mutate()}
              update={(student, present) => change.mutate({ student, present })}
            />
          )}
        </Result>
      )}
    </>
  );
}
export default function Staff({ user }: { user: User }) {
  const { pathname: path, search } = useLocation();
  const navigate = useNavigate();
  const [selected, setSelected] = useState('');
  const [editing, setEditing] = useState<'new' | Course | null>(null);
  const client = useQueryClient();
  const courses = useQuery({
    queryKey: ['staff', 'courses'],
    queryFn: () => api.courses(),
  });
  const remove = useMutation({
    mutationFn: api.deleteCourse,
    onSuccess: async () => {
      setSelected('');
      await client.invalidateQueries({ queryKey: ['staff', 'courses'] });
    },
  });
  const isAttendance = path === '/attendance';
  const isCourses = path === '/courses';
  const overview = !isAttendance && !isCourses;
  const admin = user.role === 'admin';
  return (
    <>
      <PageTitle
        label={admin ? 'Admin workspace' : 'Teacher workspace'}
        title={
          isAttendance
            ? 'Live attendance'
            : isCourses
              ? 'Courses'
              : 'Welcome, ' + user.full_name.split(' ')[0]
        }
        detail={
          isAttendance
            ? 'Start a session and watch check-ins as they arrive.'
            : isCourses
              ? 'Manage courses and student enrollments.'
              : admin
                ? 'Manage courses and teacher assignments.'
                : 'Manage your courses and take attendance.'
        }
      />
      {isCourses && (
        <button className="primary" onClick={() => setEditing('new')}>
          <Plus size={16} /> New course
        </button>
      )}
      {isCourses && editing && (
        <CourseEditor
          key={editing === 'new' ? 'new' : editing.id}
          course={editing === 'new' ? undefined : editing}
          admin={admin}
          close={() => setEditing(null)}
        />
      )}
      <ErrorText error={remove.error} />
      <Result query={courses}>
        {(items) => {
          const course =
            items.find(
              (item) =>
                item.id ===
                (selected || new URLSearchParams(search).get('course')),
            ) ?? items[0];
          if (!course)
            return <Empty>No courses yet. Use Courses to create one.</Empty>;
          if (isAttendance)
            return (
              <>
                <label className="filter">
                  Course
                  <select
                    value={course.id}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.course_code} · {item.title}
                      </option>
                    ))}
                  </select>
                </label>
                <Sessions key={course.id} course={course} />
              </>
            );
          const choose = (id: string, to: string) =>
            navigate(to + '?course=' + encodeURIComponent(id));
          return (
            <>
              {overview && <h2>Your courses</h2>}
              <div className="grid">
                {items.map((item) => (
                  <article className="card course-card" key={item.id}>
                    <span className="course-icon">
                      <BookOpen size={20} />
                    </span>
                    <span className="code">{item.course_code}</span>
                    <h2>{item.title}</h2>
                    {admin && (
                      <small className="break">
                        Teacher ID {item.teacher_id}
                      </small>
                    )}
                    <div className="inline">
                      {overview && (
                        <button
                          onClick={() =>
                            choose(item.id, admin ? '/courses' : '/attendance')
                          }
                        >
                          {admin ? 'Manage course' : 'Open attendance'}
                        </button>
                      )}
                      {isCourses && (
                        <>
                          <button
                            aria-pressed={course.id === item.id}
                            onClick={() => setSelected(item.id)}
                          >
                            Roster
                          </button>
                          <button onClick={() => setEditing(item)}>Edit</button>
                          <button
                            disabled={remove.isPending}
                            onClick={() => {
                              if (
                                window.confirm(
                                  'Delete ' + item.course_code + '?',
                                )
                              )
                                remove.mutate(item.id);
                            }}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              {isCourses && <Roster key={course.id} course={course} />}
            </>
          );
        }}
      </Result>
    </>
  );
}
