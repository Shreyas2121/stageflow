import { apiUrl } from '../../config/env';
import { ApiError } from './api-error';

export const REQUEST_TIMEOUT_MS = 10_000;
export async function request<T>(
  path: string,
  parse: (body: unknown) => T,
  options: RequestInit = {},
): Promise<T> {
  const url = `${apiUrl()}${path}`;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    signal.throwIfAborted();
    const response = await fetch(url, { ...options, signal });
    const body: unknown =
      response.status === 204
        ? undefined
        : await response.json().catch(() => {
            signal.throwIfAborted();
            if (response.ok)
              throw new ApiError(
                'StageFlow returned an invalid response.',
                response.status,
                'invalid_response',
              );
            return null;
          });
    signal.throwIfAborted();
    if (!response.ok) {
      const record = typeof body === 'object' && body !== null ? body : {};
      throw new ApiError(
        'message' in record && typeof record.message === 'string'
          ? record.message
          : `The request failed (${response.status}). Please try again.`,
        response.status,
        'error' in record && typeof record.error === 'string' ? record.error : 'http_error',
      );
    }
    try {
      return parse(body);
    } catch {
      throw new ApiError(
        'StageFlow returned an invalid response.',
        response.status,
        'invalid_response',
      );
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (timeout.aborted)
      throw new ApiError('StageFlow took too long to respond. Please try again.', null, 'timeout');
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      'Unable to reach StageFlow. Check that the API is running and try again.',
      null,
      'network_error',
    );
  }
}
