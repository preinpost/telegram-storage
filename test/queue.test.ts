import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RateLimitQueue } from '../src/queue.ts';
import { MockTgClient } from '../src/tg/mock.ts';
import { sleep } from '../src/util.ts';

const dirs: string[] = [];

function mockDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tgstorage-queue-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function send(tg: MockTgClient, name: string, data = Buffer.from('payload')) {
  return tg.sendDocument({ chatId: '-100test', fileName: name, data });
}

describe('RateLimitQueue', () => {
  it('runs tasks strictly one at a time', async () => {
    const tg = new MockTgClient({ dir: mockDir() });
    const queue = new RateLimitQueue({ minIntervalMs: 0, maxRetries: 0, baseBackoffMs: 10, maxBackoffMs: 100 });

    let inFlight = 0;
    let maxInFlight = 0;
    const tasks = [0, 1, 2, 3, 4].map((i) =>
      queue.run(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(30);
        inFlight--;
        return send(tg, `f${i}`);
      }),
    );
    await Promise.all(tasks);
    expect(maxInFlight).toBe(1);
    expect(tg.sendLog).toHaveLength(5);
  });

  it('enforces the minimum interval between executions', async () => {
    const tg = new MockTgClient({ dir: mockDir() });
    const queue = new RateLimitQueue({ minIntervalMs: 40, maxRetries: 0, baseBackoffMs: 10, maxBackoffMs: 100 });

    const started = Date.now();
    await Promise.all([0, 1, 2].map((i) => queue.run(() => send(tg, `f${i}`))));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(2 * 40); // 3 tasks → 2 enforced gaps
    const log = tg.sendLog;
    for (let i = 1; i < log.length; i++) {
      expect(log[i]!.at - log[i - 1]!.at).toBeGreaterThanOrEqual(40);
    }
  });

  it('retries 429 respecting retry_after and growing exponential backoff', async () => {
    const tg = new MockTgClient({
      dir: mockDir(),
      failures: [
        { atCallIndex: 0, status: 429, retryAfterSeconds: 0.1 },
        { atCallIndex: 1, status: 429, retryAfterSeconds: 0.1 },
      ],
    });
    const queue = new RateLimitQueue({ minIntervalMs: 0, maxRetries: 4, baseBackoffMs: 100, maxBackoffMs: 1000 });

    const started = Date.now();
    await queue.run(() => send(tg, 'f'));
    const elapsed = Date.now() - started;

    expect(tg.sendLog).toHaveLength(1); // succeeded on the 3rd attempt
    // attempt1 delay = max(100 retry_after, 100 backoff) = 100ms
    // attempt2 delay = max(100 retry_after, 200 backoff) = 200ms
    expect(elapsed).toBeGreaterThanOrEqual(300);
  });

  it('does not retry non-429 errors', async () => {
    const tg = new MockTgClient({
      dir: mockDir(),
      failures: [{ atCallIndex: 0, status: 400, message: 'bad request' }],
    });
    const queue = new RateLimitQueue({ minIntervalMs: 0, maxRetries: 4, baseBackoffMs: 10, maxBackoffMs: 100 });

    await expect(queue.run(() => send(tg, 'f'))).rejects.toMatchObject({
      status: 400,
      message: 'bad request',
    });
    expect(tg.sendLog).toHaveLength(0);
  });

  it('gives up after maxRetries when 429 persists', async () => {
    const failures = Array.from({ length: 10 }, (_, i) => ({
      atCallIndex: i,
      status: 429,
      retryAfterSeconds: 0,
    }));
    const tg = new MockTgClient({ dir: mockDir(), failures });
    const queue = new RateLimitQueue({ minIntervalMs: 0, maxRetries: 2, baseBackoffMs: 10, maxBackoffMs: 100 });

    await expect(queue.run(() => send(tg, 'f'))).rejects.toMatchObject({ status: 429 });
    expect(tg.sendLog).toHaveLength(0);
    expect(tg.callCount).toBe(3); // 1 initial + 2 retries
  });
});
