// @vitest-environment jsdom
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, materialsApi } from '../src/services';
import { fingerprint, saveAuth } from '../src/storage';

interface Fixture {
  app: {
    inject: (request: object) => Promise<{
      rawPayload: Buffer;
      statusCode: number;
      headers: Record<string, string>;
    }>;
    close: () => Promise<void>;
  };
  accounts: Record<
    'teacher' | 'student' | 'second' | 'admin',
    { id: string; email: string }
  >;
  course: string;
}
vi.hoisted(() => vi.stubEnv('VITE_USE_MOCKS', 'false'));
let fixture: Fixture;
const fixturePath = pathToFileURL(resolve('tests/backend-fixture.mjs')).href;

function blobBytes(blob: Blob) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

beforeEach(async () => {
  const { createBackend } = await import(/* @vite-ignore */ fixturePath);
  fixture = await createBackend();
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    let payload = init.body ?? undefined;
    if (payload instanceof FormData) {
      const boundary = 'campusos-test-upload';
      const chunks: Buffer[] = [];
      for (const [name, value] of payload.entries()) {
        const disposition = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
        if (typeof value === 'string') {
          chunks.push(Buffer.from(`${disposition}\r\n\r\n${value}\r\n`));
        } else {
          const bytes = await blobBytes(value);
          chunks.push(Buffer.from(`${disposition}; filename="${value.name}"\r\nContent-Type: ${value.type}\r\n\r\n`),
            Buffer.from(bytes), Buffer.from('\r\n'));
        }
      }
      headers.set('Content-Type', 'multipart/form-data; boundary=' + boundary);
      payload = Buffer.concat([...chunks, Buffer.from(`--${boundary}--\r\n`)]);
    }
    const response = await fixture.app.inject({
      method: init.method,
      url: path,
      headers: Object.fromEntries(headers.entries()),
      payload,
    });
    return new Response(response.statusCode === 204 ? null : Uint8Array.from(response.rawPayload), {
      status: response.statusCode,
      headers: response.headers,
    });
  });
});
afterEach(async () => {
  saveAuth(null);
  vi.unstubAllGlobals();
  await fixture?.app.close();
});

it('runs a live teacher and student attendance session against Fastify and SQLite', async () => {
  const { password } = await import(/* @vite-ignore */ fixturePath);
  const { accounts, course } = fixture;
  const teacher = await api.login(accounts.teacher.email, password);
  expect(teacher.user.role).toBe('teacher');
  saveAuth(teacher);
  expect(await api.roster(course)).toHaveLength(2);
  const created = await api.saveCourse({
    course_code: 'DB102',
    title: 'Database Systems',
  });
  await api.saveCourse({ course_code: 'DB102', title: 'DBMS' }, created.id);
  await api.enroll(created.id, accounts.student.id);
  expect(await api.roster(created.id)).toHaveLength(1);
  await api.unenroll(created.id, accounts.student.id);
  await api.deleteCourse(created.id);

  const session = await api.start(course);
  expect(session.otp_code).toMatch(/^\d{6}$/);
  expect((await api.sessions(course))[0].is_active).toBe(true);

  const student = await api.login(accounts.student.email, password);
  expect(student.user.role).toBe('student');
  saveAuth(student);
  expect((await api.courses(true))[0].id).toBe(course);
  const [active] = await api.active();
  expect(active).toMatchObject({
    session_id: session.id,
    already_punched: false,
  });
  expect(active).not.toHaveProperty('otp_code');
  const wrong = session.otp_code === '000000' ? '000001' : '000000';
  await expect(
    api.punch(session.id, wrong, fingerprint()),
  ).rejects.toMatchObject({ code: 'INVALID_OTP' });
  await api.punch(session.id, session.otp_code!, fingerprint());
  await expect(
    api.punch(session.id, session.otp_code!, fingerprint()),
  ).rejects.toMatchObject({ code: 'ALREADY_PUNCHED' });
  expect((await api.active())[0].already_punched).toBe(true);
  expect((await api.summary(course)).courses[0]).toMatchObject({
    sessions_attended: 1,
    attendance_percentage: 100,
  });

  saveAuth(teacher);
  expect((await api.session(session.id)).present[0].student_id).toBe(
    accounts.student.id,
  );
  await api.mark(session.id, accounts.second.id);
  expect(
    (await api.session(session.id)).present.some(
      (entry) =>
        entry.student_id === accounts.second.id && Boolean(entry.manual),
    ),
  ).toBe(true);
  await api.unmark(session.id, accounts.second.id);
  expect((await api.session(session.id)).absent[0].student_id).toBe(
    accounts.second.id,
  );
  await api.stop(session.id);
  expect((await api.session(session.id)).session).not.toHaveProperty(
    'otp_code',
  );

  saveAuth(student);
  expect(await api.active()).toEqual([]);
  expect((await api.summary()).records[0].session_id).toBe(session.id);

  const admin = await api.login(accounts.admin.email, password);
  saveAuth(admin);
  expect((await api.courses())[0].teacher_id).toBe(accounts.teacher.id);
});

it('renders the teacher-to-student check-in flow and shows an empty live materials list', async () => {
  const { password } = await import(/* @vite-ignore */ fixturePath);
  const { accounts } = fixture;
  saveAuth(await api.login(accounts.teacher.email, password));
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('scrollTo', () => undefined);
  vi.stubGlobal('confirm', () => true);

  function open(path: string) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <MemoryRouter
          initialEntries={[path]}
        >
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return () => {
      view.unmount();
      client.clear();
    };
  }

  const closeTeacher = open('/attendance');
  const start = await screen.findByRole('button', { name: 'Start session' });
  await waitFor(() =>
    expect((start as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(start);
  await screen.findByRole('heading', { name: 'Session code' });
  const code = screen.getByText(/^\d{6}$/).textContent!;
  closeTeacher();

  saveAuth(await api.login(accounts.student.email, password));
  const closeStudent = open('/');
  const digits = await screen.findByRole('group', {
    name: 'Six-digit session code',
  });
  fireEvent.paste(within(digits).getByRole('textbox', { name: 'Digit 1' }), {
    clipboardData: { getData: () => code },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
  await screen.findByText('Attendance recorded for CS101.');
  await screen.findByText('100.00%');
  fireEvent.click(screen.getByRole('link', { name: 'Materials' }));
  await screen.findByText('No materials on this page.');
  expect(screen.queryByText('Demo data')).toBeNull();
  closeStudent();

  saveAuth(await api.login(accounts.teacher.email, password));
  const closeResults = open('/attendance');
  await screen.findByRole('heading', { name: 'Present · 1' });
  fireEvent.click(screen.getByRole('button', { name: 'End session' }));
  await screen.findByRole('heading', { name: 'Session results' });
  closeResults();
}, 15000);

it('validates the login form and signs in through the real backend', async () => {
  const { password } = await import(/* @vite-ignore */ fixturePath);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('scrollTo', () => undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  try {
    const submit = await screen.findByRole('button', { name: 'Sign in' });
    fireEvent.click(submit);
    await screen.findByText('Enter a valid email address.');
    await screen.findByText('Enter your password.');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: fixture.accounts.teacher.email } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
    fireEvent.click(submit);
    await screen.findByRole('heading', { name: 'Welcome, Test' });
  } finally {
    view.unmount();
    client.clear();
  }
});

it('uploads, edits, downloads and deletes live materials with backend role checks', async () => {
  const { password } = await import(/* @vite-ignore */ fixturePath);
  const { accounts, course } = fixture;
  const teacher = await api.login(accounts.teacher.email, password);
  saveAuth(teacher);
  const header = '%PDF-1.7\n';
  const object = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const pdf = header + object + 'xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n' +
    'trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n' + (header.length + object.length) + '\n%%EOF\n';
  const form = new FormData();
  form.append('courseId', course);
  form.append('title', 'Class notes');
  form.append('file', new File([pdf], 'notes.pdf', { type: 'application/pdf' }));
  const uploaded = await materialsApi.upload(form);
  expect(uploaded.original_filename).toBe('notes.pdf');
  expect((await materialsApi.list(course, 1)).items).toHaveLength(1);
  await materialsApi.update(uploaded.id, { title: 'Updated notes', description: null });
  saveAuth(await api.login(accounts.student.email, password));
  expect((await materialsApi.list(course, 1)).items[0].title).toBe('Updated notes');
  const downloaded = await materialsApi.download(uploaded.id);
  expect(Buffer.from(await blobBytes(downloaded)).toString()).toBe(pdf);
  await expect(materialsApi.remove(uploaded.id)).rejects.toMatchObject({ status: 403 });
  saveAuth(teacher);
  await materialsApi.remove(uploaded.id);
  expect((await materialsApi.list(course, 1)).items).toEqual([]);
});

it('finds a student in the roster, clears selection on course switch, and enrolls the selected result', async () => {
  const { password } = await import(/* @vite-ignore */ fixturePath);
  saveAuth(await api.login(fixture.accounts.teacher.email, password));
  const course = await api.saveCourse({ course_code: 'ZZ101', title: 'Search test course' });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('scrollTo', () => undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/courses?course=' + course.id]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  try {
    const findStudent = async () => {
      fireEvent.change(await screen.findByRole('searchbox', { name: 'Find a student' }), {
        target: { value: fixture.accounts.student.email },
      });
      return screen.findByRole('radio', { name: /Test Student/ });
    };
    const switchRoster = (title: string) => {
      const card = screen.getByRole('heading', { name: title }).closest('article');
      if (!card) throw new Error('Course card not found');
      fireEvent.click(within(card).getByRole('button', { name: 'Roster' }));
    };

    fireEvent.click(await findStudent());
    expect((screen.getByRole('button', { name: 'Enroll student' }) as HTMLButtonElement).disabled).toBe(false);

    switchRoster('Computer Science');
    expect((screen.getByRole('searchbox', { name: 'Find a student' }) as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Enroll student' }) as HTMLButtonElement).disabled).toBe(true);
    expect((await findStudent() as HTMLInputElement).disabled).toBe(true);

    switchRoster('Search test course');
    fireEvent.click(await findStudent());
    fireEvent.click(screen.getByRole('button', { name: 'Enroll student' }));
    await screen.findByRole('button', { name: 'Remove' });
    await waitFor(() => {
      expect((screen.getByRole('radio', { name: /Test Student/ }) as HTMLInputElement).disabled).toBe(true);
    });
    expect((await api.roster(course.id)).map((entry) => entry.student_id)).toEqual([fixture.accounts.student.id]);
  } finally {
    view.unmount();
    client.clear();
  }
}, 15000);

it('provisions an empty campus and records a new student check-in through the UI', async () => {
  const { createBackend, password } = await import(/* @vite-ignore */ fixturePath);
  await fixture.app.close();
  const empty = await createBackend({ seed: false });
  fixture = empty;
  const admin = 'admin@new-campus.test';
  const teacher = 'teacher@new-campus.test';
  const student = 'student@new-campus.test';
  await empty.bootstrap({ full_name: 'Campus Admin', email: admin, password });

  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('scrollTo', () => undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/users']}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  const fill = (label: string, value: string) => {
    fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
  };
  const button = (name: string) => screen.getByRole('button', { name });
  const navigate = (name: string) => fireEvent.click(screen.getByRole('link', { name }));
  async function signIn(email: string) {
    const submit = await screen.findByRole('button', { name: 'Sign in' });
    fill('Email', email);
    fill('Password', password);
    fireEvent.click(submit);
    await screen.findByRole('button', { name: 'Sign out' });
  }

  try {
    await signIn(admin);
    await screen.findByRole('heading', { name: 'Create account' });
    for (const [role, name, email] of [
      ['teacher', 'New Teacher', teacher],
      ['student', 'New Student', student],
    ]) {
      fill('Full name', name);
      fill('Email', email);
      fill('Role', role);
      fill('Password', password);
      fireEvent.click(button('Create account'));
      await screen.findByText('Account created for ' + email + '.');
    }

    navigate('Courses');
    fireEvent.click(await screen.findByRole('button', { name: 'New course' }));
    await screen.findByRole('option', { name: 'New Teacher (' + teacher + ')' });
    fill('Course code', 'NEW101');
    fill('Title', 'New Campus Course');
    const teacherSelect = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Teacher' });
    fill('Teacher', teacherSelect.options[1].value);
    fireEvent.click(button('Save course'));
    await screen.findByRole('heading', { name: 'New Campus Course' });

    fireEvent.click(button('Sign out'));
    await signIn(teacher);
    const search = await screen.findByRole('searchbox', { name: 'Find a student' });
    fireEvent.change(search, { target: { value: student } });
    fireEvent.click(await screen.findByRole('radio', { name: /New Student/ }));
    fireEvent.click(button('Enroll student'));
    await screen.findByRole('button', { name: 'Remove' });

    navigate('Attendance');
    const start = await screen.findByRole<HTMLButtonElement>('button', { name: 'Start session' });
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await screen.findByRole('heading', { name: 'Session code' });
    const code = screen.getByText(/^\d{6}$/).textContent!;

    fireEvent.click(button('Sign out'));
    await signIn(student);
    navigate('Overview');
    const digits = await screen.findByRole('group', { name: 'Six-digit session code' });
    fireEvent.paste(within(digits).getByRole('textbox', { name: 'Digit 1' }), {
      clipboardData: { getData: () => code },
    });
    fireEvent.click(button('Submit code'));
    await screen.findByText('Attendance recorded for NEW101.');

    fireEvent.click(button('Sign out'));
    await signIn(teacher);
    navigate('Attendance');
    await screen.findByRole('heading', { name: 'Present · 1' });
    expect(screen.getByText('New Student')).toBeTruthy();
  } finally {
    view.unmount();
    client.clear();
  }
}, 20000);

it('saves a mark in the teacher screen and shows only the signed-in student’s result', async () => {
  const { password } = await import(/* @vite-ignore */ fixturePath);
  const { accounts } = fixture;
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('scrollTo', () => undefined);

  async function openMarks(email: string) {
    saveAuth(await api.login(email, password));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/marks']}><App /></MemoryRouter>
      </QueryClientProvider>,
    );
    return () => {
      view.unmount();
      client.clear();
    };
  }

  let close = await openMarks(accounts.teacher.email);
  try {
    await screen.findByText('No assessments yet.');
    const titleInput = screen.getByLabelText<HTMLInputElement>('Assessment title');
    const maximumInput = screen.getByLabelText<HTMLInputElement>('Maximum score');
    fireEvent.change(titleInput, { target: { value: '   ' } });
    expect(titleInput.checkValidity()).toBe(false);
    fireEvent.change(maximumInput, { target: { value: '0' } });
    expect(maximumInput.checkValidity()).toBe(false);
    fireEvent.change(maximumInput, { target: { value: '0.5' } });
    expect(maximumInput.checkValidity()).toBe(true);
    fireEvent.change(screen.getByLabelText('Assessment title'), { target: { value: 'Database quiz' } });
    fireEvent.change(screen.getByLabelText('Maximum score'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create assessment' }));

    const score = await screen.findByRole('spinbutton', { name: 'Score for Test Student' });
    const row = score.closest('li');
    if (!row) throw new Error('Missing student score row');
    fireEvent.change(score, { target: { value: '0' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save score' }));
    await within(row).findByText('0 / 20');
    await within(row).findByText('Score saved.');

    close();
    close = await openMarks(accounts.teacher.email);
    const saved = await screen.findByRole<HTMLInputElement>('spinbutton', { name: 'Score for Test Student' });
    expect(saved.value).toBe('0');

    close();
    close = await openMarks(accounts.student.email);
    await screen.findByRole('heading', { name: 'Your results' });
    await screen.findByText('Database quiz');
    await screen.findByText('0 / 20');
    expect(screen.queryByText('second@integration.test')).toBeNull();

    close();
    close = await openMarks(accounts.second.email);
    await screen.findByText('Database quiz');
    await screen.findByText('Ungraded');
    expect(screen.queryByText('0 / 20')).toBeNull();
  } finally {
    close();
  }
}, 20000);
