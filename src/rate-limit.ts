import type { Context, MiddlewareHandler } from 'hono';

/**
 * In-memory sliding-window rate limiter (no dependencies). Keeps a timestamp
 * list per key (client IP) and admits at most `limit` hits per `windowMs`.
 * Instances are per-app, so the window state lives only for the process
 * lifetime — fine for login-throttling on a single-node deployment.
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly limit: number,
  ) {}

  /**
   * Records one hit (when allowed) and reports whether the request may pass.
   * `retryAfterSeconds` is only meaningful when `allowed` is false.
   */
  check(key: string, now: number = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      const retryAfterMs = Math.max(1, this.windowMs - (now - recent[0]!));
      return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Hono middleware: 429 + Retry-After when the limiter says no. */
export function rateLimitMiddleware(
  limiter: SlidingWindowRateLimiter,
  keyOf: (c: Context) => string,
): MiddlewareHandler {
  return async (c, next) => {
    const { allowed, retryAfterSeconds } = limiter.check(keyOf(c));
    if (!allowed) {
      c.header('Retry-After', String(retryAfterSeconds));
      return c.json({ error: 'too many requests' }, 429);
    }
    await next();
  };
}

/**
 * Best-effort client identity: the leftmost X-Forwarded-For entry (set by a
 * reverse proxy), then X-Real-IP, then the raw socket address. Only used as a
 * throttling key — never trusted for anything security-sensitive.
 */
export function clientKeyOf(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  const realIp = c.req.header('x-real-ip');
  if (realIp) return realIp.trim();
  const incoming = c.env?.incoming as { socket?: { remoteAddress?: string } } | undefined;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}
