import { TgApiError } from './errors.ts';
import { sleep } from './util.ts';

export interface QueueOptions {
  /** Minimum interval between task executions (ms). 1000 = 1 msg/sec (safe for private chats). */
  minIntervalMs: number;
  /** Number of retry attempts for 429 / retry_after errors (beyond the first attempt). */
  maxRetries: number;
  /** Base for exponential backoff (ms): delay = base * 2^(attempt-1). */
  baseBackoffMs: number;
  /** Ceiling for exponential backoff (ms). */
  maxBackoffMs: number;
}

const DEFAULT_OPTIONS: QueueOptions = {
  minIntervalMs: 1000,
  maxRetries: 4,
  baseBackoffMs: 1000,
  maxBackoffMs: 60_000,
};

/**
 * Rate-limit queue for all Telegram API calls.
 *
 * - Runs tasks strictly one at a time (Telegram per-chat message limits).
 * - Enforces a minimum interval between executions (throttling).
 * - On 429 (flood control) it waits at least `retry_after` AND the exponential
 *   backoff for the current attempt, then retries up to `maxRetries` times.
 *
 * Used by both the mock and the real grammY client, so queue behavior is
 * identical (and testable) without a bot token.
 */
export class RateLimitQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private lastExecutionStart = 0;

  constructor(private readonly options: QueueOptions = DEFAULT_OPTIONS) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.then(() => this.execute(fn));
    this.chain = task.catch(() => undefined);
    return task;
  }

  private async execute<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const wait = Math.max(0, this.options.minIntervalMs - (now - this.lastExecutionStart));
    if (wait > 0) await sleep(wait);
    this.lastExecutionStart = Date.now();

    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        const retryAfterMs = retryAfterMsOf(err);
        if (retryAfterMs === null) throw err;
        attempt++;
        if (attempt > this.options.maxRetries) throw err;
        const backoff = Math.min(
          this.options.maxBackoffMs,
          this.options.baseBackoffMs * 2 ** (attempt - 1),
        );
        await sleep(Math.max(retryAfterMs, backoff));
      }
    }
  }
}

function retryAfterMsOf(err: unknown): number | null {
  if (err instanceof TgApiError && err.retryAfterSeconds !== undefined) {
    return Math.max(0, err.retryAfterSeconds * 1000);
  }
  return null;
}
