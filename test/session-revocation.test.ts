import { afterEach, describe, expect, it } from 'vitest';
import { devLogin, startHarness } from './helpers.ts';
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

describe('session revocation (logout invalidates issued tokens)', () => {
  it('rejects a replayed session cookie after logout', async () => {
    const h = await harness();
    const cookie = await devLogin(h.baseUrl, 'alice');
    const meBefore = await fetch(`${h.baseUrl}/api/auth/me`, { headers: { cookie } });
    expect(meBefore.status).toBe(200);

    const out = await fetch(`${h.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(204);

    // The same token (e.g. a stolen/replayed cookie) is now rejected:
    // logout bumped users.sess_version and the token carries the old version.
    const meAfter = await fetch(`${h.baseUrl}/api/auth/me`, { headers: { cookie } });
    expect(meAfter.status).toBe(401);
  });

  it('does not invalidate other users sessions', async () => {
    const h = await harness();
    const alice = await devLogin(h.baseUrl, 'alice');
    const bob = await devLogin(h.baseUrl, 'bob');

    await fetch(`${h.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: alice } });

    const aliceMe = await fetch(`${h.baseUrl}/api/auth/me`, { headers: { cookie: alice } });
    expect(aliceMe.status).toBe(401);
    const bobMe = await fetch(`${h.baseUrl}/api/auth/me`, { headers: { cookie: bob } });
    expect(bobMe.status).toBe(200);
  });

  it('issues a fresh working session after logging back in', async () => {
    const h = await harness();
    const first = await devLogin(h.baseUrl, 'alice');
    await fetch(`${h.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: first } });

    const second = await devLogin(h.baseUrl, 'alice');
    const me = await fetch(`${h.baseUrl}/api/auth/me`, { headers: { cookie: second } });
    expect(me.status).toBe(200);
  });

  it('logout without a valid session still returns 204 and clears the cookie', async () => {
    const h = await harness();
    const res = await fetch(`${h.baseUrl}/api/auth/logout`, { method: 'POST' });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie') ?? '').toContain('tg_session=');
  });
});

describe('session cookie Secure flag (COOKIE_SECURE)', () => {
  async function devLoginCookie(h: TestHarness, username: string): Promise<string> {
    const res = await fetch(`${h.baseUrl}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    return res.headers.get('set-cookie') ?? '';
  }

  it('sets Secure when cookieSecure is enabled (HTTPS deployments)', async () => {
    const h = await harness({ cookieSecure: true });
    const setCookie = await devLoginCookie(h, 'carol');
    expect(setCookie).toContain('Secure');
  });

  it('omits Secure by default (plain-HTTP local dev)', async () => {
    const h = await harness();
    const setCookie = await devLoginCookie(h, 'carol');
    expect(setCookie).not.toContain('Secure');
  });
});
