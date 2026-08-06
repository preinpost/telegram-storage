import { afterEach, describe, expect, it } from 'vitest';
import { startHarness } from './helpers.ts';
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

function devLoginRequest(baseUrl: string, username: string): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
}

describe('login rate limiting (RATE_LIMIT_PER_MINUTE)', () => {
  it('returns 429 once the per-minute budget is exhausted, with Retry-After', async () => {
    const h = await harness({ rateLimitPerMinute: 2, autoLogin: false });
    expect((await devLoginRequest(h.baseUrl, 'alice')).status).toBe(200);
    expect((await devLoginRequest(h.baseUrl, 'bob')).status).toBe(200);

    const third = await devLoginRequest(h.baseUrl, 'carol');
    expect(third.status).toBe(429);
    const body = (await third.json()) as { error: string };
    expect(body.error).toBe('too many requests');
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('shares the budget between both login endpoints', async () => {
    const h = await harness({ rateLimitPerMinute: 2, autoLogin: false });
    expect((await devLoginRequest(h.baseUrl, 'alice')).status).toBe(200);
    // second hit via /api/auth/telegram (503 because no bot token — but the
    // limiter runs BEFORE the handler, so the budget is consumed)
    const telegram = await fetch(`${h.baseUrl}/api/auth/telegram`, { method: 'POST' });
    expect(telegram.status).toBe(503);
    const third = await devLoginRequest(h.baseUrl, 'bob');
    expect(third.status).toBe(429);
  });

  it('does not throttle when RATE_LIMIT_PER_MINUTE=0 (disabled)', async () => {
    const h = await harness({ rateLimitPerMinute: 0, autoLogin: false });
    for (let i = 0; i < 15; i++) {
      const res = await devLoginRequest(h.baseUrl, `user-${i}`);
      expect(res.status).toBe(200);
    }
  });

  it('leaves non-login endpoints untouched', async () => {
    const h = await harness({ rateLimitPerMinute: 1, autoLogin: false });
    expect((await devLoginRequest(h.baseUrl, 'alice')).status).toBe(200);
    expect((await devLoginRequest(h.baseUrl, 'bob')).status).toBe(429);

    const config = await fetch(`${h.baseUrl}/api/auth/config`);
    expect(config.status).toBe(200);
    const health = await fetch(`${h.baseUrl}/health`);
    expect(health.status).toBe(200);
  });
});
