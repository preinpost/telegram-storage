import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import type { AppDeps } from '../src/app.ts';
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
  close(): Promise<void>;
}

export interface StartHarnessOptions {
  queueIntervalMs?: number;
  queueMaxRetries?: number;
  failures?: MockFailure[];
  chatId?: string;
}

/**
 * Starts a real HTTP server (via @hono/node-server) wired to a temp SQLite DB
 * and a mock Telegram client — the full production stack, token-free.
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
  const deps: AppDeps = {
    db,
    tg,
    queue,
    tmpDir: join(tmp, 'tmp'),
    chatId: options.chatId ?? '-100telegram-storage-mock',
  };
  const app = createApp(deps);
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    db,
    tg,
    queue,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export function formData(buf: Buffer, filename: string): FormData {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  return fd;
}

export async function uploadBytes(
  baseUrl: string,
  buf: Buffer,
  filename = 'test.bin',
): Promise<{ id: string; status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/files`, { method: 'POST', body: formData(buf, filename) });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { id: String(body.id ?? ''), status: res.status, body };
}

export async function download(
  baseUrl: string,
  id: string,
): Promise<{ status: number; buffer: Buffer; headers: Headers }> {
  const res = await fetch(`${baseUrl}/api/files/${id}/download`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buffer, headers: res.headers };
}
