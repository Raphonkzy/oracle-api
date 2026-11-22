/** An error the client should see. Everything else becomes a generic 500. */
export class HttpError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    public readonly code: string,
    message: string,
    /** Plain values the app can use to word the message in the person's language. */
    public readonly details?: Record<string, string | number>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "bad_request") => new HttpError(400, code, message);
export const notFound = (message = "Not found.") => new HttpError(404, "not_found", message);
