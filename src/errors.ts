/**
 * HTTP-level error carrying a status code. The Hono error handler maps this
 * to a JSON response with the same status.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Telegram Bot API error. `retryAfterSeconds` mirrors the `retry_after`
 * parameter Telegram returns with 429 (flood control) responses; the
 * RateLimitQueue uses it to back off before retrying.
 */
export class TgApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TgApiError';
  }
}
