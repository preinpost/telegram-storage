import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../app.ts';
import type { Db, UserRow } from '../db.ts';
import { HttpError } from '../errors.ts';
import { SESSION_COOKIE_NAME, verifySession } from './session.ts';

/**
 * Hono middleware that resolves the session cookie to a user and attaches it
 * to the context (`c.get('user')`). Attach this to every protected route.
 */
export function requireAuth(secret: string, db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('user', resolveAuthUser(secret, db, c));
    await next();
  };
}

export function resolveAuthUser(secret: string, db: Db, c: Context<AppEnv>): UserRow {
  const token = getCookie(c, SESSION_COOKIE_NAME);
  const payload = verifySession(token, secret);
  if (!payload) throw new HttpError(401, 'authentication required');
  const user = db.getUserById(payload.uid);
  if (!user) throw new HttpError(401, 'authentication required');
  // A logout bumped users.sess_version, so any token signed with an older
  // version (including replayed stolen cookies) is now invalid.
  if (user.sess_version !== payload.v) throw new HttpError(401, 'session revoked');
  return user;
}
