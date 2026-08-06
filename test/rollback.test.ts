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
      body: formData(original, 'rollback.bin'),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('simulated telegram outage');

    // Rollback: no files row, no parts rows.
    expect(h.db.listActiveFiles()).toHaveLength(0);
    expect(h.db.countParts()).toBe(0);

    // The 1 chunk that was already sent to Telegram stays there (orphan) —
    // inherent to the store-in-Telegram-first design; only DB state is atomic.
    expect(h.tg.stored.size).toBe(1);
  });

  it('rolls back when the very first chunk fails', async () => {
    const h = await harness({
      failures: [{ atCallIndex: 0, status: 500, message: 'first chunk rejected' }],
    });
    const res = await fetch(`${h.baseUrl}/api/files`, {
      method: 'POST',
      body: formData(randomBuffer(SIZE), 'fail-first.bin'),
    });
    expect(res.status).toBe(500);
    expect(h.db.listActiveFiles()).toHaveLength(0);
    expect(h.db.countParts()).toBe(0);
    expect(h.tg.stored.size).toBe(0);
  });
});
