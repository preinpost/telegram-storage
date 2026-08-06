import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import type { AppDeps } from '../src/app.ts';
import { DiskCache } from '../src/cache.ts';
import { Db } from '../src/db.ts';
import { RateLimitQueue } from '../src/queue.ts';
import { MockTgClient } from '../src/tg/mock.ts';
import type { MockFailure } from '../src/tg/mock.ts';

export function randomBuffer(size: number): Buffer {
  return randomBytes(size);
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface TestHarness {
  baseUrl: string;
  db: Db;
  tg: MockTgClient;
  queue: RateLimitQueue;
  /**
   * Session cookie of the auto-provisioned dev user ("admin", DEV_AUTH=true).
   * Empty when the harness starts with devAuth=false.
   */
  cookie: string;
  close(): Promise<void>;
}

export interface StartHarnessOptions {
  queueIntervalMs?: number;
  queueMaxRetries?: number;
  failures?: MockFailure[];
  chatId?: string;
  /** DEV_AUTH mode for the harness. Default: true (dev-login available). */
  devAuth?: boolean;
  /**
   * Automatically dev-login the first user ("admin") after start.
   * Default: true. Set false when a test needs to control the very first user
   * (e.g. first-user-admin bootstrap).
   */
  autoLogin?: boolean;
  /** Bot token used for Telegram widget auth. Default: null (mock mode). */
  botToken?: string | null;
  /** Bot username advertised by GET /api/auth/config. Default: null. */
  botUsername?: string | null;
  /** Session signing secret. Default: a fixed test secret. */
  sessionSecret?: string;
  /** Login rate limit per minute (0 disables). Default 10. */
  rateLimitPerMinute?: number;
  /** Enable the download disk cache under this temp subdirectory. */
  cacheDir?: string;
  /** Cache size cap in bytes (default 256 MiB). */
  cacheMaxBytes?: number;
  /** Add the Secure flag to session cookies. */
  cookieSecure?: boolean;
}

/**
 * Starts a real HTTP server (via @hono/node-server) wired to a temp SQLite DB
 * and a mock Telegram client — the full production stack, token-free.
 * Unless devAuth=false, the first dev-login ("admin") happens automatically
 * and its session cookie is returned on the harness.
 */
export async function startHarness(options: StartHarnessOptions = {}): Promise<TestHarness> {
  const tmp = mkdtempSync(join(tmpdir(), 'tgstorage-test-'));
  const db = new Db(join(tmp, 'test.db'));
  const tg = new MockTgClient({
    dir: join(tmp, 'mock-tg'),
    ...(options.failures ? { failures: options.failures } : {}),
  });
  const queue = new RateLimitQueue({
    minIntervalMs: options.queueIntervalMs ?? 10,
    maxRetries: options.queueMaxRetries ?? 4,
    baseBackoffMs: 20,
    maxBackoffMs: 500,
  });
  const devAuth = options.devAuth ?? true;
  const autoLogin = options.autoLogin ?? true;
  const deps: AppDeps = {
    db,
    tg,
    queue,
    tmpDir: join(tmp, 'tmp'),
    chatId: options.chatId ?? '-100telegram-storage-mock',
    botToken: options.botToken ?? null,
    botUsername: options.botUsername ?? null,
    devAuth,
    sessionSecret: options.sessionSecret ?? 'test-session-secret',
    rateLimitPerMinute: options.rateLimitPerMinute ?? 10,
    cookieSecure: options.cookieSecure ?? false,
    cache: options.cacheDir
      ? new DiskCache(join(tmp, options.cacheDir), options.cacheMaxBytes ?? 256 * 1024 * 1024)
      : null,
  };
  const app = createApp(deps);
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  let cookie = '';
  if (devAuth && autoLogin) {
    cookie = await devLogin(baseUrl, 'admin');
  }

  return {
    baseUrl,
    db,
    tg,
    queue,
    cookie,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * POST /api/auth/dev-login and return the session cookie (requires the
 * harness to run with DEV_AUTH enabled).
 */
export async function devLogin(baseUrl: string, username: string, displayName?: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(displayName ? { username, displayName } : { username }),
  });
  if (!res.ok) throw new Error(`dev-login failed: HTTP ${res.status}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('dev-login did not return a session cookie');
  return setCookie.split(';')[0]!;
}

/**
 * fetch against the harness with the given session cookie attached (defaults
 * to the harness's own admin cookie; pass cookie='' to send no cookie).
 */
export async function api(
  h: TestHarness,
  path: string,
  init: RequestInit = {},
  cookie: string = h.cookie,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie && !headers.has('cookie')) headers.set('cookie', cookie);
  return fetch(h.baseUrl + path, { ...init, headers });
}

export function formData(buf: Buffer, filename: string, fields?: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields ?? {})) fd.append(key, value);
  fd.append('file', new Blob([buf]), filename);
  return fd;
}

export async function uploadBytes(
  baseUrl: string,
  buf: Buffer,
  filename = 'test.bin',
  cookie?: string,
  fields?: Record<string, string>,
): Promise<{ id: string; status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: cookie ? { cookie } : {},
    body: formData(buf, filename, fields),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { id: String(body.id ?? ''), status: res.status, body };
}

export async function download(
  baseUrl: string,
  id: string,
  cookie?: string,
): Promise<{ status: number; buffer: Buffer; headers: Headers }> {
  const res = await fetch(`${baseUrl}/api/files/${id}/download`, {
    headers: cookie ? { cookie } : {},
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buffer, headers: res.headers };
}
