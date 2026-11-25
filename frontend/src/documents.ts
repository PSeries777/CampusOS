import { apiResponse, http, responseData } from './api';

export interface DocumentMetadata {
  id: string;
  course_id: string;
  uploaded_by: string;
  title: string;
  description: string | null;
  original_filename: string;
  file_size: number;
  mime_type: string;
  uploaded_at: string;
}

export const documentLimits = {
  bytes: 50 * 1024 * 1024,
  title: 200,
  description: 1000,
};

export const documents = {
  async list(courseId: string, page: number, signal?: AbortSignal) {
    const query = new URLSearchParams({ courseId, page: String(page) });
    const response = await apiResponse(
      '/documents?' + query,
      'GET',
      undefined,
      signal,
    );
    const next = Number(response.headers.get('X-Next-Page'));
    return {
      items: await responseData<DocumentMetadata[]>(response),
      nextPage: Number.isSafeInteger(next) && next > page ? next : undefined,
    };
  },
  upload(courseId: string, title: string, description: string, file: File) {
    const body = new FormData();
    body.append('courseId', courseId);
    body.append('title', title);
    if (description) body.append('description', description);
    body.append('file', file);
    return http<DocumentMetadata>('/documents', 'POST', body);
  },
  update(id: string, title: string, description: string | null) {
    return http<DocumentMetadata>(
      '/documents/' + encodeURIComponent(id),
      'PATCH',
      { title, description },
    );
  },
  async remove(id: string) {
    await apiResponse('/documents/' + encodeURIComponent(id), 'DELETE');
  },
  async download(document: DocumentMetadata) {
    const response = await apiResponse(
      '/documents/' + encodeURIComponent(document.id) + '/download',
    );
    return response.blob();
  },
};
