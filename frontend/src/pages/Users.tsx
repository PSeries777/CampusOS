import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { Empty, ErrorText, PageTitle, Result } from '../ui';
import { usersApi, usersQueryKey } from '../users';

export default function Users() {
  const client = useQueryClient();
  const users = useQuery({ queryKey: usersQueryKey, queryFn: usersApi.list });
  const create = useMutation({
    mutationFn: usersApi.create,
    gcTime: 0,
    onSuccess: () => client.invalidateQueries({ queryKey: usersQueryKey }),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const role = data.get('role');
    if (role !== 'teacher' && role !== 'student') return;
    create.mutate({
      full_name: String(data.get('name')).trim(),
      email: String(data.get('email')).trim(),
      password: String(data.get('password')),
      role,
    }, { onSuccess: () => form.reset() });
  }

  return (
    <>
      <PageTitle label="Admin workspace" title="Users" detail="Create teacher and student accounts." />
      <form className="card form-stack" onSubmit={submit}>
        <h2>Create account</h2>
        <label>Full name<input name="name" autoComplete="off" required maxLength={120} /></label>
        <label>Email<input name="email" type="email" autoComplete="off" required maxLength={254} /></label>
        <label>
          Role
          <select name="role" required>
            <option value="">Choose a role</option>
            <option value="teacher">Teacher</option>
            <option value="student">Student</option>
          </select>
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={72} />
        </label>
        <ErrorText error={create.error} />
        {create.isSuccess && <p role="status">Account created for {create.data.email}.</p>}
        <div><button className="primary" disabled={create.isPending}>Create account</button></div>
      </form>
      <section className="card">
        <h2>Accounts</h2>
        <Result query={users}>
          {(items) => items.length ? (
            <ul className="rows">
              {items.map((user) => (
                <li key={user.id}>
                  <span><strong>{user.full_name}</strong><small>{user.email}</small></span>
                  <span>{user.role}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>No accounts found.</Empty>}
        </Result>
      </section>
    </>
  );
}
