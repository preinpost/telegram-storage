import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { randomSecret } from './auth/session.ts';
import type { DownloadCache } from './cache.ts';
import type { Db, UserRow } from './db.ts';
import { HttpError } from './errors.ts';
import type { RateLimitQueue } from './queue.ts';
import { authRoutes } from './routes/auth.ts';
import { filesRoutes } from './routes/files.ts';
import { foldersRoutes } from './routes/folders.ts';
import { statsRoutes } from './routes/stats.ts';
import type { TgClient } from './tg/types.ts';

export interface AppDeps {
  db: Db;
  tg: TgClient;
  queue: RateLimitQueue;
  tmpDir: string;
  chatId: string | null;
  /** Telegram bot token (used for Login Widget signature verification). */
  botToken: string | null;
  /** Telegram bot username (shown by the Login Widget). null → widget hidden. */
  botUsername: string | null;
  /** DEV_AUTH=true enables POST /api/auth/dev-login. */
  devAuth: boolean;
  /** Session signing secret; null → ephemeral random secret. */
  sessionSecret: string | null;
  /** Optional download cache; null/undefined → downloads always hit Telegram. */
  cache?: DownloadCache | null;
  /** Login rate limit per minute (0 disables). Default 10. */
  rateLimitPerMinute?: number;
  /** Add the Secure flag to the session cookie (deployments behind HTTPS). */
  cookieSecure?: boolean;
}

/** Context variables shared by all routes (set by the requireAuth middleware). */
export type AppEnv = {
  Variables: {
    user: UserRow;
  };
};

/**
 * Hono app factory. Dependencies are injected so tests can run the full HTTP
 * stack against a mock Telegram client and an in-memory/temp SQLite DB.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Resolve the session secret once per app so every route signs/verifies
  // cookies with the same key (null → ephemeral secret, sessions die on restart).
  const sessionSecret = deps.sessionSecret ?? randomSecret();

  app.use('*', requestLogger);
  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[error] ${c.req.method} ${c.req.path}:`, err);
    return c.json(
      { error: err instanceof Error ? err.message : 'internal error' },
      status as ContentfulStatusCode,
    );
  });

  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/api/auth', authRoutes(deps, sessionSecret));
  app.route('/api/folders', foldersRoutes(deps, sessionSecret));
  app.route('/api/files', filesRoutes(deps, sessionSecret));
  app.route('/api/stats', statsRoutes(deps, sessionSecret));

  return app;
}

/**
 * One-line request log: method, path, status, duration, authenticated user id
 * (when the request carried a valid session). Replaces hono/logger so the
 * log also carries the resolved user id.
 */
const requestLogger: MiddlewareHandler<AppEnv> = async (c, next) => {
  const started = Date.now();
  await next();
  const user = c.get('user') as UserRow | undefined;
  const ms = Date.now() - started;
  console.log(`[req] ${c.res.status} ${c.req.method} ${c.req.path} ${ms}ms${user ? ` uid=${user.id}` : ''}`);
};
