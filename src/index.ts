import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { DiskCache } from './cache.ts';
import { loadConfig } from './config.ts';
import { Db } from './db.ts';
import { RateLimitQueue } from './queue.ts';
import { GrammyTgClient } from './tg/grammy.ts';
import { MockTgClient } from './tg/mock.ts';

const config = loadConfig();

const db = new Db(config.dbPath);
// Uploads left in 'uploading' by a previous run can never commit (their
// spool is gone) — mark them failed on startup.
void db.failStaleUploads();
const real = config.botToken !== null;
// Mock mode works without any token; a placeholder chat id keeps uploads happy.
const tg = real ? new GrammyTgClient(config.botToken as string) : new MockTgClient({ dir: join(config.tmpDir, 'mock-tg') });
const queue = new RateLimitQueue({
  minIntervalMs: config.queueIntervalMs,
  maxRetries: config.queueMaxRetries,
  baseBackoffMs: config.queueBaseBackoffMs,
  maxBackoffMs: config.queueMaxBackoffMs,
});
const chatId = config.chatId ?? (real ? null : '-100telegram-storage-mock');

if (!config.sessionSecret) {
  console.warn(
    'WARNING: SESSION_SECRET is not set — using an ephemeral session secret; all sessions are invalidated on restart. Set SESSION_SECRET in .env for persistent sessions.',
  );
}
if (config.devAuth) {
  console.warn(
    'WARNING: DEV_AUTH=true — POST /api/auth/dev-login (username → session) is enabled. Disable it in production.',
  );
}
if (config.cacheDir) {
  console.warn(
    `Download cache enabled: ${config.cacheDir} (cap ${config.cacheMaxMb} MiB). Large downloads are fully assembled before streaming.`,
  );
}

const app = createApp({
  db,
  tg,
  queue,
  tmpDir: config.tmpDir,
  chatId,
  botToken: config.botToken,
  botUsername: config.botUsername,
  devAuth: config.devAuth,
  sessionSecret: config.sessionSecret,
  cache: config.cacheDir ? new DiskCache(config.cacheDir, config.cacheMaxMb * 1024 * 1024) : null,
  rateLimitPerMinute: config.rateLimitPerMinute,
  cookieSecure: config.cookieSecure,
});

// Single-container deployment: serve the built SPA (web/dist) next to the
// API when STATIC_DIR is set (the Docker image sets it default). The API
// routes already finalize their responses, so the @hono/node-server
// serveStatic middleware (which early-returns on a finalized response) never
// shadows them. The second middleware is the SPA history fallback: any
// client-router path that isn't a real file serves index.html.
if (config.staticDir) {
  app.use('*', serveStatic({ root: config.staticDir, index: 'index.html' }));
  app.use('*', serveStatic({ root: config.staticDir, path: '/index.html' }));
}

if (config.staticDir) {
  console.log(`Serving static SPA from ${config.staticDir}`);
}
serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(
    `telegram-storage listening on http://${config.host}:${info.port} ` +
      `(telegram client: ${real ? 'grammY (real)' : 'MOCK'})`,
  );
  if (real && !config.chatId) {
    console.warn('WARNING: TELEGRAM_BOT_TOKEN is set but STORAGE_CHAT_ID is missing — uploads will fail.');
  }
});
