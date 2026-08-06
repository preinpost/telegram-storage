import { afterEach, describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { verifyTelegramAuth } from '../src/auth/telegram.ts';
import { devLogin, startHarness } from './helpers.ts';
import type { TestHarness } from './helpers.ts';

// Known-good widget vector, computed independently of the implementation:
//   botToken = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
//   data_check_string = "auth_date=1700000000\nfirst_name=Alice\nid=123456789\nusername=alice_dev"
//   secret_key = SHA256(botToken), hash = HMAC-SHA256(secret_key, data_check_string)
const BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
const AUTH_DATE = 1700000000;
const VALID_HASH = 'b92c2bb6ab80b4616e0adb848515b1251ed69534367cfd254fe0d5088daa1bb7';
const NOW = AUTH_DATE + 100; // 100s later — well inside the 24h window

function widgetParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    id: '123456789',
    first_name: 'Alice',
    username: 'alice_dev',
    auth_date: String(AUTH_DATE),
    hash: VALID_HASH,
    ...overrides,
  };
}

/**
 * Signs widget fields with a CURRENT auth_date (the widget must be fresh for
 * the HTTP flow, which checks auth_date against real time). Computed with the
 * documented algorithm — the pure function itself is covered by the fixed
 * known vector above.
 */
function signWidget(fields: Record<string, string>, botToken: string): string {
  const dataCheckString = Object.entries(fields)
    .filter(([key, value]) => key !== 'hash' && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  return createHmac('sha256', createHash('sha256').update(botToken).digest())
    .update(dataCheckString)
    .digest('hex');
}

function freshWidget(botToken: string, overrides: Record<string, string> = {}): Record<string, string> {
  const authDate = Math.floor(Date.now() / 1000);
  const fields = {
    id: '123456789',
    first_name: 'Alice',
    username: 'alice_dev',
    auth_date: String(authDate),
    ...overrides,
  };
  return { ...fields, hash: signWidget(fields, botToken) };
}

describe('verifyTelegramAuth (pure function, known test vector)', () => {
  it('accepts the known-good widget vector', () => {
    const result = verifyTelegramAuth(widgetParams(), BOT_TOKEN, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.id).toBe(123456789);
      expect(result.user.username).toBe('alice_dev');
      expect(result.user.first_name).toBe('Alice');
    }
  });

  it('rejects when any signed field is tampered with', () => {
    const result = verifyTelegramAuth(widgetParams({ username: 'mallory' }), BOT_TOKEN, NOW);
    expect(result.ok).toBe(false);
  });

  it('rejects a missing hash', () => {
    const { hash: _hash, ...rest } = widgetParams();
    const result = verifyTelegramAuth(rest, BOT_TOKEN, NOW);
    expect(result.ok).toBe(false);
  });

  it('rejects an auth_date older than 24h', () => {
    const result = verifyTelegramAuth(widgetParams(), BOT_TOKEN, AUTH_DATE + 25 * 60 * 60);
    expect(result.ok).toBe(false);
  });

  it('rejects an auth_date in the future beyond the skew window', () => {
    const result = verifyTelegramAuth(widgetParams(), BOT_TOKEN, AUTH_DATE - 10 * 60);
    expect(result.ok).toBe(false);
  });

  it('rejects a signature produced with a different bot token', () => {
    const result = verifyTelegramAuth(widgetParams(), '000000:not-the-real-token', NOW);
    expect(result.ok).toBe(false);
  });
});

const harnesses: TestHarness[] = [];

async function harness(options?: Parameters<typeof startHarness>[0]): Promise<TestHarness> {
  const h = await startHarness(options);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

async function widgetLogin(
  h: TestHarness,
  params: Record<string, string>,
): Promise<{ status: number; cookie: string; body: Record<string, unknown> }> {
  const res = await fetch(`${h.baseUrl}/api/auth/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, cookie: setCookie ? setCookie.split(';')[0]! : '', body };
}

describe('telegram widget login (HTTP)', () => {
  it('logs in via the widget callback and issues an httpOnly session cookie', async () => {
    const h = await harness({ botToken: BOT_TOKEN, autoLogin: false });
    const params = freshWidget(BOT_TOKEN);
    const { status, cookie, body } = await widgetLogin(h, params);
    expect(status).toBe(200);
    expect(cookie).toContain('tg_session=');
    const setCookie = (await fetch(`${h.baseUrl}/api/auth/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(freshWidget(BOT_TOKEN)).toString(),
    })).headers.get('set-cookie');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect((body.user as Record<string, unknown>).username).toBe('alice_dev');
    expect((body.user as Record<string, unknown>).role).toBe('admin'); // first user bootstrap

    const me = await fetch(`${h.baseUrl}/api/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { user: { username: string; role: string } };
    expect(meBody.user.username).toBe('alice_dev');
    expect(meBody.user.role).toBe('admin');
  });

  it('rejects a tampered widget callback with 401', async () => {
    const h = await harness({ botToken: BOT_TOKEN });
    // Fields signed for the real user, but the username is swapped afterwards.
    const signed = freshWidget(BOT_TOKEN);
    const tampered = { ...signed, username: 'mallory' };
    const { status } = await widgetLogin(h, tampered);
    expect(status).toBe(401);
  });

  it('returns 503 for telegram auth when no bot token is configured', async () => {
    const h = await harness({ botToken: null });
    const { status } = await widgetLogin(h, freshWidget(BOT_TOKEN));
    expect(status).toBe(503);
  });

  it('reuses the same user row for a returning telegram id', async () => {
    const h = await harness({ botToken: BOT_TOKEN });
    const first = await widgetLogin(h, freshWidget(BOT_TOKEN));
    const second = await widgetLogin(h, freshWidget(BOT_TOKEN));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const me1 = (await (await fetch(`${h.baseUrl}/api/auth/me`, { headers: { cookie: first.cookie } })).json()) as {
      user: { id: string };
    };
    const me2 = (await (await fetch(`${h.baseUrl}/api/auth/me`, { headers: { cookie: second.cookie } })).json()) as {
      user: { id: string };
    };
    expect(me1.user.id).toBe(me2.user.id);
  });
});

describe('dev-login and sessions', () => {
  it('issues a session for a dev user when DEV_AUTH is on', async () => {
    const h = await harness();
    const cookie = await devLogin(h.baseUrl, 'alice');
    expect(cookie).toContain('tg_session=');
    const me = await fetch(`${h.baseUrl}/api/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { username: string } };
    expect(body.user.username).toBe('alice');
  });

  it('bootstraps the first user as admin and later users as members', async () => {
    // No auto-login: the test controls who the very first user is.
    const h = await harness({ autoLogin: false });
    const alice = await devLogin(h.baseUrl, 'alice');
    const bob = await devLogin(h.baseUrl, 'bob');
    const aliceMe = (await (await fetch(`${h.baseUrl}/api/auth/me`, { headers: { cookie: alice } })).json()) as {
      user: { role: string };
    };
    const bobMe = (await (await fetch(`${h.baseUrl}/api/auth/me`, { headers: { cookie: bob } })).json()) as {
      user: { role: string };
    };
    expect(aliceMe.user.role).toBe('admin');
    expect(bobMe.user.role).toBe('member');
  });

  it('rejects dev-login with 401 when DEV_AUTH is off', async () => {
    const h = await harness({ devAuth: false });
    const res = await fetch(`${h.baseUrl}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for /api/auth/me without a session', async () => {
    const h = await harness({ devAuth: false });
    const res = await fetch(`${h.baseUrl}/api/auth/me`);
    expect(res.status).toBe(401);
  });

  it('logout clears the session cookie', async () => {
    const h = await harness();
    const res = await fetch(`${h.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: h.cookie },
    });
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('tg_session=');
    // Without the cookie, /me is rejected again.
    const me = await fetch(`${h.baseUrl}/api/auth/me`);
    expect(me.status).toBe(401);
  });

  it('rejects a tampered session cookie', async () => {
    const h = await harness();
    const [name, value] = h.cookie.split('=');
    const tampered = `${name}=${value!.slice(0, -1)}${value!.endsWith('a') ? 'b' : 'a'}`;
    const me = await fetch(`${h.baseUrl}/api/auth/me`, { headers: { cookie: tampered } });
    expect(me.status).toBe(401);
  });
});

describe('GET /api/auth/config (public auth-mode advertisement)', () => {
  it('is public and reports devAuth + botUsername', async () => {
    const h = await harness({ devAuth: true, botUsername: 'my_storage_bot' });
    const res = await fetch(`${h.baseUrl}/api/auth/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devAuth: boolean; botUsername: string | null };
    expect(body.devAuth).toBe(true);
    expect(body.botUsername).toBe('my_storage_bot');
  });

  it('reports devAuth=false and botUsername=null when unconfigured', async () => {
    const h = await harness({ devAuth: false });
    const res = await fetch(`${h.baseUrl}/api/auth/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devAuth: boolean; botUsername: string | null };
    expect(body.devAuth).toBe(false);
    expect(body.botUsername).toBeNull();
  });
});
