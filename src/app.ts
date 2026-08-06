import { Hono } from 'hono';
import { logger } from 'hono/logger';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Db } from './db.ts';
import { HttpError } from './errors.ts';
import type { RateLimitQueue } from './queue.ts';
import { filesRoutes } from './routes/files.ts';
import type { TgClient } from './tg/types.ts';

export interface AppDeps {
  db: Db;
  tg: TgClient;
  queue: RateLimitQueue;
  tmpDir: string;
  chatId: string | null;
}

/**
 * Hono app factory. Dependencies are injected so tests can run the full HTTP
 * stack against a mock Telegram client and an in-memory/temp SQLite DB.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use('*', logger());
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
  app.route('/api/files', filesRoutes(deps));

  return app;
}
