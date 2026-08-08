import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppDeps, AppEnv } from '../app.ts';
import { requireAuth } from '../auth/middleware.ts';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  signSession,
  verifySession,
} from '../auth/session.ts';
import { verifyTelegramAuth } from '../auth/telegram.ts';
import type { UserRow } from '../db.ts';
import { HttpError } from '../errors.ts';
import { clientKeyOf, rateLimitMiddleware, SlidingWindowRateLimiter } from '../rate-limit.ts';

/**
 * POST /api/auth/telegram — Telegram Login Widget callback (form data).
 * POST /api/auth/dev-login — dev-only username login (DEV_AUTH=true).
 * GET  /api/auth/me        — current user.
 * POST /api/auth/logout    — clears the session cookie and revokes the session.
 */
export function authRoutes(deps: AppDeps, sessionSecret: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const secure = deps.cookieSecure === true;
  const rateLimit = loginRateLimitGuard(deps);

  /**
   * GET /api/auth/config — public auth-mode advertisement for the web UI:
   * whether dev-login is enabled and which bot username the Login Widget
   * should render (null → no widget). No secrets are exposed.
   */
  app.get('/config', (c) => {
    return c.json({ devAuth: deps.devAuth, botUsername: deps.botUsername ?? null });
  });

  /**
   * POST /api/auth/telegram — Telegram Login Widget callback (form data).
   * GET  /api/auth/telegram — same, but as the widget's data-auth-url target:
   * the browser navigates here with query params after authorization, the
   * server verifies the HMAC and redirects back to / (SPA-safe).
   */
  app.all('/telegram', rateLimit, async (c) => {
    if (!deps.botToken) {
      if (c.req.method === 'GET') {
        return c.redirect(`/?login_error=${encodeURIComponent('telegram auth requires a bot token (TELEGRAM_BOT_TOKEN)')}`);
      }
      throw new HttpError(503, 'telegram auth requires a bot token (TELEGRAM_BOT_TOKEN)');
    }
    const params: Record<string, string> = {};
    if (c.req.method === 'GET') {
      for (const [key, value] of Object.entries(c.req.query())) {
        if (typeof value === 'string') params[key] = value;
      }
    } else {
      const body = await c.req.parseBody();
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'string') params[key] = value;
      }
    }
    const result = verifyTelegramAuth(params, deps.botToken);
    if (!result.ok) {
      if (c.req.method === 'GET') {
        return c.redirect(`/?login_error=${encodeURIComponent(result.reason)}`);
      }
      throw new HttpError(401, result.reason);
    }

    const now = Date.now();
    const displayName =
      [result.user.first_name, result.user.last_name].filter(Boolean).join(' ').trim() || null;
    const user = await deps.db.findOrCreateUser(
      String(result.user.id),
      result.user.username ?? `tg_${result.user.id}`,
      displayName,
      now,
    );
    setSessionCookie(c, sessionSecret, user, now, secure);
    if (c.req.method === 'GET') return c.redirect('/');
    return c.json({ user: toUserJson(user) });
  });

  app.post('/dev-login', rateLimit, async (c) => {
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
    const user = await deps.db.findOrCreateUser(null, username, displayName, now);
    setSessionCookie(c, sessionSecret, user, now, secure);
    return c.json({ user: toUserJson(user) });
  });

  app.get('/me', requireAuth(sessionSecret, deps.db), (c) => {
    return c.json({ user: toUserJson(c.get('user')) });
  });

  /**
   * Logout clears the cookie AND bumps users.sess_version, so any token
   * issued before this moment (including a replayed stolen cookie) is
   * rejected by requireAuth from now on.
   */
  app.post('/logout', async (c) => {
    const payload = verifySession(getCookie(c, SESSION_COOKIE_NAME), sessionSecret);
    if (payload) {
      const user = await deps.db.getUserById(payload.uid);
      if (user) await deps.db.bumpSessionVersion(user.id);
    }
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
    return c.body(null, 204);
  });

  return app;
}

/**
 * Rate-limit middleware for the two login endpoints, or a no-op pass-through
 * when RATE_LIMIT_PER_MINUTE is 0 (disabled). The limiter instance is shared
 * by both endpoints so attempts against either count toward the same budget.
 */
function loginRateLimitGuard(deps: AppDeps): MiddlewareHandler<AppEnv> {
  const perMinute = deps.rateLimitPerMinute ?? 10;
  if (perMinute <= 0) {
    return async (_c, next) => next();
  }
  const limiter = new SlidingWindowRateLimiter(60_000, perMinute);
  return rateLimitMiddleware(limiter, clientKeyOf);
}

function setSessionCookie(
  c: Context,
  secret: string,
  user: UserRow,
  now: number,
  secure: boolean,
): void {
  // Sign with the user's CURRENT sess_version so a later logout (version +1)
  // invalidates this exact token.
  setCookie(
    c,
    SESSION_COOKIE_NAME,
    signSession(secret, user.id, now, undefined, user.sess_version),
    sessionCookieOptions(secure),
  );
}

/**
 * httpOnly + SameSite=Lax (CSRF protection for same-origin calls). The Secure
 * flag is opt-in via COOKIE_SECURE=true (deployments behind HTTPS) because
 * local dev runs over plain HTTP.
 */
function sessionCookieOptions(secure: boolean): Parameters<typeof setCookie>[3] {
  return {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
    ...(secure ? { secure: true } : {}),
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
