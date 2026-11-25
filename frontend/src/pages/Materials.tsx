import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api } from '../services';
import { documents, documentLimits } from '../documents';
import type { DocumentMetadata } from '../documents';
import type { Role } from '../types';
import { Empty, ErrorText, PageTitle, Result } from '../ui';

function DocumentForm({
  courseId,
  entry,
  close,
}: {
  courseId: string;
  entry?: DocumentMetadata;
  close: () => void;
}) {
  const client = useQueryClient();
  const [validation, setValidation] = useState<Error | null>(null);
  const save = useMutation({
    mutationFn: ({
      title,
      description,
      file,
    }: {
      title: string;
      description: string;
      file?: File;
    }) =>
      entry
        ? documents.update(entry.id, title, description || null)
        : documents.upload(courseId, title, description, file!),
    onSuccess: async () => {
      await client.resetQueries({
        queryKey: ['materials', courseId],
        exact: true,
      });
      close();
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) return;
    const fields = new FormData(event.currentTarget);
    const title = String(fields.get('title')).trim();
    const description = String(fields.get('description')).trim();
    const file = fields.get('file');
    if (!title) {
      setValidation(new Error('Enter a title.'));
      return;
    }
    if (
      !entry &&
      (!(file instanceof File) ||
        !file.size ||
        file.size > documentLimits.bytes)
    ) {
      setValidation(new Error('Choose a non-empty file up to 50 MiB.'));
      return;
    }
    setValidation(null);
    save.mutate({
      title,
      description,
      file: file instanceof File ? file : undefined,
    });
  }
  return (
    <form className="card form-stack" onSubmit={submit}>
      <h2>{entry ? 'Edit material' : 'Upload material'}</h2>
      <label>
        Title
        <input
          name="title"
          required
          maxLength={documentLimits.title}
          defaultValue={entry?.title}
        />
      </label>
      <label>
        Description <small>Optional</small>
        <textarea
          name="description"
          rows={3}
          maxLength={documentLimits.description}
          defaultValue={entry?.description ?? ''}
        />
      </label>
      {!entry && (
        <label>
          File <small>PDF, DOCX, PNG, JPEG or ZIP · up to 50 MiB</small>
          <input
            name="file"
            type="file"
            accept=".pdf,.docx,.png,.jpg,.jpeg,.zip"
            required
          />
        </label>
      )}
      <ErrorText error={validation ?? save.error} />
      <div className="inline">
        <button className="primary" disabled={save.isPending}>
          {save.isPending
            ? entry
              ? 'Saving…'
              : 'Uploading…'
            : entry
              ? 'Save changes'
              : 'Upload'}
        </button>
        <button type="button" disabled={save.isPending} onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CourseMaterials({
  courseId,
  staff,
}: {
  courseId: string;
  staff: boolean;
}) {
  const key = ['materials', courseId];
  const client = useQueryClient();
  const [editing, setEditing] = useState<'upload' | DocumentMetadata | null>(
    null,
  );
  const [notice, setNotice] = useState('');
  const list = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) =>
      documents.list(courseId, pageParam, signal),
    initialPageParam: 1,
    getNextPageParam: (page) => page.nextPage,
  });
  const download = useMutation({
    mutationFn: async (entry: DocumentMetadata) => {
      const url = URL.createObjectURL(await documents.download(entry));
      const link = window.document.createElement('a');
      link.href = url;
      link.download = entry.original_filename;
      window.document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
  const remove = useMutation({
    mutationFn: documents.remove,
    onSuccess: async () => {
      setNotice('Material deleted.');
      await client.resetQueries({ queryKey: key, exact: true });
    },
  });
  const entries = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      {staff && !editing && (
        <button
          className="primary"
          onClick={() => {
            setNotice('');
            setEditing('upload');
          }}
        >
          Upload material
        </button>
      )}
      {editing && (
        <DocumentForm
          key={editing === 'upload' ? 'upload' : editing.id}
          courseId={courseId}
          entry={editing === 'upload' ? undefined : editing}
          close={() => setEditing(null)}
        />
      )}
      {notice && <p role="status">{notice}</p>}
      <ErrorText error={download.error ?? remove.error} />
      {list.isPending && (
        <div className="card skeleton" role="status">
          Loading materials…
        </div>
      )}
      <ErrorText error={list.error} />
      {list.isError && !list.data && (
        <button onClick={() => void list.refetch()}>Retry</button>
      )}
      {list.isSuccess && !entries.length && (
        <Empty>No materials for this course yet.</Empty>
      )}
      {entries.length > 0 && (
        <section className="card" aria-label="Course files">
          <ul className="rows">
            {entries.map((entry) => (
              <li key={entry.id} className="materials-row">
                <span className="break">
                  <strong>{entry.title}</strong>
                  <small>
                    {entry.original_filename} ·{' '}
                    {new Intl.NumberFormat(undefined, {
                      style: 'unit',
                      unit: 'kilobyte',
                      maximumFractionDigits: 1,
                    }).format(entry.file_size / 1000)}
                  </small>
                  {entry.description && <small>{entry.description}</small>}
                </span>
                <div className="inline">
                  <button
                    disabled={download.isPending}
                    onClick={() => download.mutate(entry)}
                    aria-label={'Download ' + entry.title}
                  >
                    <Download size={16} /> Download
                  </button>
                  {staff && (
                    <>
                      <button
                        disabled={!!editing || remove.isPending}
                        onClick={() => {
                          setNotice('');
                          setEditing(entry);
                        }}
                        aria-label={'Edit ' + entry.title}
                      >
                        Edit
                      </button>
                      <button
                        disabled={!!editing || remove.isPending}
                        aria-label={'Delete ' + entry.title}
                        onClick={() => {
                          if (window.confirm('Delete ' + entry.title + '?')) {
                            setNotice('');
                            remove.mutate(entry.id);
                          }
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {list.hasNextPage && (
        <button
          disabled={list.isFetching}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  );
}

export default function Materials({ role }: { role: Role }) {
  const [selected, setSelected] = useState('');
  const courses = useQuery({
    queryKey: ['materials-courses', role],
    queryFn: () => api.courses(role === 'student'),
  });
  return (
    <>
      <PageTitle label={role + ' workspace'} title="Course materials" />
      <Result query={courses}>
        {(items) => {
          const course =
            items.find((entry) => entry.id === selected) ?? items[0];
          if (!course) return <Empty>No courses available.</Empty>;
          return (
            <>
              <label className="filter">
                Course
                <select
                  value={course.id}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  {items.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.course_code} · {entry.title}
                    </option>
                  ))}
                </select>
              </label>
              <CourseMaterials
                key={course.id}
                courseId={course.id}
                staff={role !== 'student'}
              />
            </>
          );
        }}
      </Result>
    </>
  );
}
