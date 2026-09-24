export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, d);
export const unauthorized = (m = 'Authentication required') => new HttpError(401, m);
export const forbidden = (m = 'Not allowed for this role') => new HttpError(403, m);
export const notFound = (m = 'Resource not found') => new HttpError(404, m);
export const conflict = (m: string, d?: unknown) => new HttpError(409, m, d);
/**
 * The server is fine; something it depends on is not configured or not answering — a missing
 * `ANTHROPIC_API_KEY`, the model API refusing the request.
 *
 * It matters that this is an `HttpError` and not a plain `Error`. The error handler sanitises every
 * unhandled error to "Unexpected server error" in production, which is right for a genuine internal
 * fault and useless for a configuration one: the operator is shown a generic 500 for a problem they
 * could have fixed in ten seconds if anyone had told them what it was.
 */
export const serviceUnavailable = (m: string, d?: unknown) => new HttpError(503, m, d);
