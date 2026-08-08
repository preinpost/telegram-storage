import { afterEach, describe, expect, it } from 'vitest';
import type { MockFailure } from '../src/tg/mock.ts';
import { formData, randomBuffer, startHarness } from './helpers.ts';
import type { TestHarness } from './helpers.ts';

const SIZE = 32 * 1024 * 1024; // 3 parts: 15 + 15 + 2 MB

const harnesses: TestHarness[] = [];

async function harness(options?: { failures?: MockFailure[] }): Promise<TestHarness> {
  const h = await startHarness(options);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

describe('upload failure rollback', () => {
  it('commits nothing when a mid-upload chunk fails', async () => {
    // Call index 1 = the 2nd chunk send fails with a non-retryable 500.
    const h = await harness({
      failures: [{ atCallIndex: 1, status: 500, message: 'simulated telegram outage' }],
    });
    const original = randomBuffer(SIZE);

    const res = await fetch(`${h.baseUrl}/api/files`, {
      method: 'POST',
      headers: { cookie: h.cookie },
      body: formData(original, 'rollback.bin'),
    });
    // Accepted synchronously (background commit), so the response is 201.
    expect(res.status).toBe(201);

    // Wait for the background commit to fail and flip the file to 'failed'.
    let failedFile: { status?: string; error?: string } | null = null;
    for (let i = 0; i < 400; i++) {
      const { files } = (await (await fetch(`${h.baseUrl}/api/files`, { headers: { cookie: h.cookie } })).json()) as {
        files: { status?: string; error?: string }[];
      };
      failedFile = files.find((f) => f.status === 'failed') ?? null;
      if (failedFile) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(failedFile?.error).toContain('simulated telegram outage');

    // Rollback: no parts rows (the pending file row stays, marked failed).
    expect(await h.db.countParts()).toBe(0);

    // The 1 chunk that was already sent to Telegram is deleted (deleteMessage).
    expect(h.tg.stored.size).toBe(0);
    expect(h.tg.deletedMessages).toHaveLength(1);
  });

  it('rolls back when the very first chunk fails', async () => {
    const h = await harness({
      failures: [{ atCallIndex: 0, status: 500, message: 'first chunk rejected' }],
    });
    const res = await fetch(`${h.baseUrl}/api/files`, {
      method: 'POST',
      headers: { cookie: h.cookie },
      body: formData(randomBuffer(SIZE), 'fail-first.bin'),
    });
    expect(res.status).toBe(201); // accepted; commit runs in the background

    // Wait for the background commit to fail and flip the file to 'failed'.
    for (let i = 0; i < 400; i++) {
      const { files } = (await (await fetch(`${h.baseUrl}/api/files`, { headers: { cookie: h.cookie } })).json()) as {
        files: { status?: string }[];
      };
      if (files.some((f) => f.status === 'failed')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await h.db.countParts()).toBe(0);
    expect(h.tg.stored.size).toBe(0);
    expect(h.tg.deletedMessages).toHaveLength(0);
  });
});
