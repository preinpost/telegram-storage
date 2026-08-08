/**
 * End-to-end round-trip verification.
 *
 * - No TELEGRAM_BOT_TOKEN  → MOCK mode: a local mock Telegram client is used,
 *   so this works with zero setup.
 * - TELEGRAM_BOT_TOKEN set → REAL mode: chunks are sent to the real
 *   STORAGE_CHAT_ID channel and downloaded back.
 *
 * In both modes the script runs the actual HTTP API (multipart upload →
 * chunked send → download reassembly → sha256 comparison → list → delete).
 *
 * Env knobs:
 *   SMOKE_FILE_SIZE_MB     file size in MiB (default: 32 mock / 8 real)
 *   SMOKE_DB_PATH          sqlite path (default ./tmp/smoke.db)
 *   SMOKE_QUEUE_INTERVAL_MS  queue interval override (default 50 mock / from config real)
 */
import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { RateLimitQueue } from '../src/queue.ts';
import { GrammyTgClient } from '../src/tg/grammy.ts';
import { MockTgClient } from '../src/tg/mock.ts';
import { sha256 } from '../src/util.ts';

const MB = 1024 * 1024;

async function main(): Promise<void> {
  const config = loadConfig();
  const real = config.botToken !== null;
  if (real && !config.chatId) {
    throw new Error('REAL mode requires STORAGE_CHAT_ID (see README / .env.example).');
  }

  const sizeMb = Number(process.env.SMOKE_FILE_SIZE_MB ?? (real ? '8' : '32'));
  if (!Number.isFinite(sizeMb) || sizeMb <= 0) throw new Error(`invalid SMOKE_FILE_SIZE_MB: ${sizeMb}`);
  const size = Math.round(sizeMb * MB);
  const dbPath = process.env.SMOKE_DB_PATH ?? './tmp/smoke.db';
  const intervalMs = real
    ? Number(process.env.SMOKE_QUEUE_INTERVAL_MS ?? config.queueIntervalMs)
    : Number(process.env.SMOKE_QUEUE_INTERVAL_MS ?? 50);

  await fsp.rm(dbPath, { force: true });
  const db = new Db(dbPath);
  const mockDir = join(config.tmpDir, 'smoke-mock-tg');
  const tg = real
    ? new GrammyTgClient(config.botToken as string)
    : new MockTgClient({ dir: mockDir });
  const queue = new RateLimitQueue({
    minIntervalMs: intervalMs,
    maxRetries: config.queueMaxRetries,
    baseBackoffMs: config.queueBaseBackoffMs,
    maxBackoffMs: config.queueMaxBackoffMs,
  });
  const app = createApp({
    db,
    tg,
    queue,
    tmpDir: join(config.tmpDir, 'smoke-tmp'),
    chatId: config.chatId ?? '-100telegram-storage-mock',
    queueIntervalMs: config.queueIntervalMs,
    botToken: config.botToken,
    botUsername: config.botUsername,
    devAuth: config.devAuth,
    sessionSecret: config.sessionSecret,
  });

  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  // The API now requires a session. The smoke script uses the dev-login
  // bypass (DEV_AUTH=true) so it still runs token-free.
  if (!config.devAuth) {
    throw new Error(
      'smoke requires DEV_AUTH=true (add DEV_AUTH=true to .env) — the API is now authenticated',
    );
  }
  const loginRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'smoke' }),
  });
  if (!loginRes.ok) throw new Error(`dev-login failed: HTTP ${loginRes.status}`);
  const loginCookie = loginRes.headers.get('set-cookie');
  if (!loginCookie) throw new Error('dev-login did not return a session cookie');
  const cookie = loginCookie.split(';')[0]!;
  const authHeaders = { cookie };

  const inputPath = join(config.tmpDir, `smoke-input-${process.pid}.bin`);

  console.log(
    `[smoke] mode=${real ? 'REAL(grammY)' : 'MOCK'} size=${sizeMb}MB (${size} bytes) ` +
      `chatId=${config.chatId ?? '(mock placeholder)'} queueInterval=${intervalMs}ms db=${dbPath}`,
  );

  try {
    // 1. generate a random file of the requested size (streaming write)
    console.log(`[smoke] generating ${sizeMb}MB of random data...`);
    const out = createWriteStream(inputPath);
    const block = Buffer.allocUnsafe(1 * MB);
    for (let written = 0; written < size; written += block.length) {
      const n = Math.min(block.length, size - written);
      randomBytes(n).copy(block, 0, 0, n);
      if (!out.write(block.subarray(0, n))) {
        await new Promise<void>((resolve) => out.once('drain', resolve));
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(() => resolve());
    });

    const original = await fsp.readFile(inputPath);
    const originalSha = sha256(original);
    console.log(`[smoke] original sha256=${originalSha}`);

    // 2. upload via the real HTTP API (multipart)
    console.log(`[smoke] uploading via POST /api/files ...`);
    const fd = new FormData();
    fd.append('file', new Blob([original]), 'smoke.bin');
    const upRes = await fetch(`${baseUrl}/api/files`, { method: 'POST', headers: authHeaders, body: fd });
    if (!upRes.ok) {
      throw new Error(`upload failed: HTTP ${upRes.status} ${await upRes.text()}`);
    }
    const uploaded = (await upRes.json()) as { id: string; size: number; partCount: number };
    console.log(
      `[smoke] uploaded id=${uploaded.id} size=${uploaded.size} parts=${uploaded.partCount}`,
    );
    if (uploaded.size !== size) {
      throw new Error(`upload size mismatch: ${uploaded.size} != ${size}`);
    }

    // 3. list
    const listRes = await fetch(`${baseUrl}/api/files`, { headers: authHeaders });
    const list = (await listRes.json()) as { files: Array<{ id: string }> };
    if (!list.files.some((f) => f.id === uploaded.id)) {
      throw new Error('uploaded file missing from GET /api/files');
    }

    // 4. download and verify sha256 + length
    console.log(`[smoke] downloading via GET /api/files/${uploaded.id}/download ...`);
    const dlRes = await fetch(`${baseUrl}/api/files/${uploaded.id}/download`, { headers: authHeaders });
    if (!dlRes.ok) {
      throw new Error(`download failed: HTTP ${dlRes.status}`);
    }
    const downloaded = Buffer.from(await dlRes.arrayBuffer());
    const downloadedSha = sha256(downloaded);
    if (downloaded.length !== size) {
      throw new Error(`download size mismatch: ${downloaded.length} != ${size}`);
    }
    if (downloadedSha !== originalSha) {
      throw new Error(`sha256 mismatch!\n  original:  ${originalSha}\n  downloaded: ${downloadedSha}`);
    }
    console.log(`[smoke] download sha256=${downloadedSha} — MATCH`);

    // 5. delete (logical) and confirm it disappears from the list
    const delRes = await fetch(`${baseUrl}/api/files/${uploaded.id}`, { method: 'DELETE', headers: authHeaders });
    if (delRes.status !== 204) {
      throw new Error(`delete failed: HTTP ${delRes.status}`);
    }
    const list2 = (await (await fetch(`${baseUrl}/api/files`, { headers: authHeaders })).json()) as { files: unknown[] };
    if (list2.files.length !== 0) {
      throw new Error('file still listed after DELETE');
    }

    console.log(`[smoke] PASS — ${sizeMb}MB round-trip integrity verified (sha256 match, ${uploaded.partCount} parts)`);
  } finally {
    server.close();
    db.close();
    await fsp.rm(inputPath, { force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('[smoke] FAIL:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
