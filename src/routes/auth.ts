import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { AppDeps, AppEnv } from '../app.ts';
import { requireAuth } from '../auth/middleware.ts';
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, signSession } from '../auth/session.ts';
import { verifyTelegramAuth } from '../auth/telegram.ts';
import type { UserRow } from '../db.ts';
import { HttpError } from '../errors.ts';

/**
 * POST /api/auth/telegram — Telegram Login Widget callback (form data).
 * POST /api/auth/dev-login — dev-only username login (DEV_AUTH=true).
 * GET  /api/auth/me        — current user.
 * POST /api/auth/logout    — clears the session cookie.
 */
export function authRoutes(deps: AppDeps, sessionSecret: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/telegram', async (c) => {
    if (!deps.botToken) {
      throw new HttpError(503, 'telegram auth requires a bot token (TELEGRAM_BOT_TOKEN)');
    }
    const body = await c.req.parseBody();
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string') params[key] = value;
    }
    const result = verifyTelegramAuth(params, deps.botToken);
    if (!result.ok) throw new HttpError(401, result.reason);

    const now = Date.now();
    const displayName =
      [result.user.first_name, result.user.last_name].filter(Boolean).join(' ').trim() || null;
    const user = deps.db.findOrCreateUser(
      String(result.user.id),
      result.user.username ?? `tg_${result.user.id}`,
      displayName,
      now,
    );
    setSessionCookie(c, sessionSecret, user.id, now);
    return c.json({ user: toUserJson(user) });
  });

  app.post('/dev-login', async (c) => {
    if (!deps.devAuth) {
      throw new HttpError(401, 'dev auth is disabled (set DEV_AUTH=true to enable)');
    }
    const body = await readJson(c);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!username || username.length > 64) {
      throw new HttpError(400, 'username is required (max 64 chars)');
    }
    const displayName =
      typeof body.displayName === 'string' && body.displayName.trim() !== ''
        ? body.displayName.trim()
        : username;
    const now = Date.now();
    const user = deps.db.findOrCreateUser(null, username, displayName, now);
    setSessionCookie(c, sessionSecret, user.id, now);
    return c.json({ user: toUserJson(user) });
  });

  app.get('/me', requireAuth(sessionSecret, deps.db), (c) => {
    return c.json({ user: toUserJson(c.get('user')) });
  });

  app.post('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
    return c.body(null, 204);
  });

  return app;
}

function setSessionCookie(c: Context, secret: string, userId: number, now: number): void {
  setCookie(c, SESSION_COOKIE_NAME, signSession(secret, userId, now), sessionCookieOptions());
}

/**
 * httpOnly + SameSite=Lax (CSRF protection for same-origin calls). Not marked
 * Secure: local dev runs over plain HTTP; deployments behind HTTPS should set
 * a reverse proxy / consider adding Secure via env in a later milestone.
 */
function sessionCookieOptions(): Parameters<typeof setCookie>[3] {
  return {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  };
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'invalid JSON body');
  });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'invalid JSON body');
  }
  return body as Record<string, unknown>;
}

export function toUserJson(user: UserRow): Record<string, unknown> {
  return {
    id: String(user.id),
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    telegramId: user.telegram_id === null ? null : user.telegram_id,
    createdAt: new Date(user.created_at).toISOString(),
  };
}
