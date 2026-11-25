import type { Envelope } from './types';
import { readAuth } from './storage';

const messages: Record<string, string> = {
  INVALID_OTP:
    'That code did not match. Check the code your teacher is displaying.',
  SESSION_CLOSED: 'This attendance session has closed.',
  SESSION_NOT_FOUND: 'This attendance session is no longer available.',
  ALREADY_PUNCHED: 'Your attendance has already been recorded.',
  DEVICE_ALREADY_USED:
    'Attendance has already been recorded on this device for this session.',
  NOT_ENROLLED: 'You are not enrolled in this course.',
  STUDENT_NOT_ENROLLED: 'This student is not enrolled in the course.',
  SESSION_ALREADY_ACTIVE: 'This course already has an open session.',
};
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(messages[code] ?? message);
  }
}

export async function apiResponse(
  path: string,
  method = 'GET',
  body?: object,
  signal?: AbortSignal,
): Promise<Response> {
  const auth = readAuth();
  const headers = new Headers({ Accept: 'application/json' });
  if (auth && path !== '/auth/login')
    headers.set('Authorization', 'Bearer ' + auth.token);
  const multipart = body instanceof FormData;
  if (body && !multipart) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch('/api' + path, {
      method,
      headers,
      signal,
      body: multipart ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      'Could not reach the server. Check your connection and try again.',
    );
  }
  if (response.status === 401 && path !== '/auth/login')
    window.dispatchEvent(new Event('campusos:expired'));
  if (response.ok) return response;
  const result = (await response
    .json()
    .catch(() => null)) as Envelope<unknown> | null;
  const fallback =
    response.status === 403
      ? 'You do not have access to this action.'
      : response.status === 429
        ? 'Too many requests. Wait a moment and try again.'
        : response.status >= 500 || !result
          ? 'The API is unavailable. Check that the backend is running.'
          : 'The request could not be completed.';
  const error = result && !result.success ? result.error : undefined;
  throw new ApiError(
    response.status,
    error?.code ?? '',
    response.status >= 500 ? fallback : (error?.message ?? fallback),
  );
}

export async function responseData<T>(response: Response): Promise<T> {
  const result = (await response
    .json()
    .catch(() => null)) as Envelope<T> | null;
  if (result?.success) return result.data;
  throw new ApiError(
    response.status,
    '',
    'The server returned an unexpected response.',
  );
}
export async function http<T>(
  path: string,
  method = 'GET',
  body?: object,
): Promise<T> {
  return responseData<T>(await apiResponse(path, method, body));
}
