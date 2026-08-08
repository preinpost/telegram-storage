import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, devLogin, randomBuffer, startHarness, uploadBytes } from './helpers.ts';
import type { TestHarness } from './helpers.ts';

const harnesses: TestHarness[] = [];

async function harness(options?: Parameters<typeof startHarness>[0]): Promise<TestHarness> {
  const h = await startHarness(options);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

async function createFolder(h: TestHarness, name: string): Promise<string> {
  const res = await api(h, '/api/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Reads a response body to completion, returning the total byte count. */
async function drain(res: Response): Promise<number> {
  const reader = res.body!.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value!.length;
  }
  return bytes;
}

describe('concurrency', () => {
  it('handles two simultaneous uploads of identical content as distinct files', async () => {
    const h = await harness();
    const data = randomBuffer(64);

    const [a, b] = await Promise.all([
      uploadBytes(h.baseUrl, data, 'same.bin', h.cookie),
      uploadBytes(h.baseUrl, data, 'same.bin', h.cookie),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();

    const [d1, d2] = await Promise.all([
      downloadBytes(h, a.id),
      downloadBytes(h, b.id),
    ]);
    expect(d1.equals(data)).toBe(true);
    expect(d2.equals(data)).toBe(true);
  });

  it('completes an in-flight multi-part download when the file is deleted mid-stream', async () => {
    const h = await harness();
    // 16MB → 2 parts, so the stream is genuinely still pulling when we delete.
    const data = randomBuffer(16 * 1024 * 1024 + 7);
    const up = await uploadBytes(h.baseUrl, data, 'big.bin', h.cookie);
    expect(up.status).toBe(201);
    expect(up.file?.status).toBe('ready');
    expect(h.tg.sendLog).toHaveLength(2);

    const res = await fetch(`${h.baseUrl}/api/files/${up.id}/download`, {
      headers: { cookie: h.cookie },
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const first = await reader.read(); // start consuming (part 0 arrives)
    expect(first.done).toBe(false);

    const del = await api(h, `/api/files/${up.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    // The open stream finishes normally (parts already resolved at open time).
    let bytes = first.value?.length ?? 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value!.length;
    }
    expect(bytes).toBe(data.length);

    // A NEW download of the now-deleted file is 404.
    const again = await api(h, `/api/files/${up.id}/download`);
    expect(again.status).toBe(404);
  });

  it('does not re-check permissions mid-download (in-flight stream completes)', async () => {
    const h = await harness();
    const bob = await devLogin(h.baseUrl, 'bob'); // member, default read
    const folderId = await createFolder(h, 'team');
    // alice grants bob write, then uploads
    await api(h, `/api/folders/${folderId}/permissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '2', role: 'write' }),
    });
    const up = await uploadBytes(h.baseUrl, randomBuffer(2048), 'f.bin', h.cookie, {
      folder_id: folderId,
    });

    const res = await fetch(`${h.baseUrl}/api/files/${up.id}/download`, {
      headers: { cookie: bob },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    // revoke bob's write grant mid-download
    const revoke = await api(h, `/api/folders/${folderId}/permissions?userId=2`, {
      method: 'DELETE',
    });
    expect(revoke.status).toBe(204);

    // in-flight stream still completes
    let bytes = first.value?.length ?? 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value!.length;
    }
    expect(bytes).toBe(2048);

    // after the revoke, bob can no longer delete (write) — only read remains
    const del = await api(h, `/api/files/${up.id}`, { method: 'DELETE' }, bob);
    expect(del.status).toBe(403);
    const dl = await api(h, `/api/files/${up.id}/download`, {}, bob);
    expect(dl.status).toBe(200); // default read still applies
  });

  it('parallel downloads of the same file both return intact bytes', async () => {
    const h = await harness();
    const data = randomBuffer(64 * 1024);
    const up = await uploadBytes(h.baseUrl, data, 'parallel.bin', h.cookie);

    const [d1, d2] = await Promise.all([
      downloadBytes(h, up.id),
      downloadBytes(h, up.id),
    ]);
    expect(d1.equals(data)).toBe(true);
    expect(d2.equals(data)).toBe(true);
  });
});

async function downloadBytes(h: TestHarness, id: string): Promise<Buffer> {
  const res = await api(h, `/api/files/${id}/download`);
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

describe('request logging', () => {
  it('logs method, path, status and user id', async () => {
    const h = await harness();
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    try {
      await api(h, '/api/files');
      expect(logs.some((line) => /\[req\] 200 GET \/api\/files \d+ms uid=1/.test(line))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
