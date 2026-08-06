import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Stateless HMAC-signed session tokens (JWT-style, but self-contained and
 * dependency-free): base64url(JSON payload) + '.' + base64url(HMAC-SHA256).
 *
 * The payload is { uid, exp, v }. `v` mirrors users.sess_version at signing
 * time: logout bumps the user's sess_version, so every previously issued
 * token (including replayed stolen cookies) is rejected at verify time.
 */
export const SESSION_COOKIE_NAME = 'tg_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface SessionPayload {
  uid: number;
  exp: number;
  /** users.sess_version at signing time (missing on legacy tokens → 0). */
  v: number;
}

export function signSession(
  secret: string,
  uid: number,
  nowMs: number,
  ttlMs: number = SESSION_TTL_MS,
  version: number = 0,
): string {
  const exp = nowMs + ttlMs;
  const body = Buffer.from(JSON.stringify({ uid, exp, v: version }), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined | null, secret: string): SessionPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { uid, exp, v } = parsed as { uid?: unknown; exp?: unknown; v?: unknown };
  if (typeof uid !== 'number' || !Number.isInteger(uid) || typeof exp !== 'number') return null;
  if (exp <= Date.now()) return null;
  const version = typeof v === 'number' && Number.isInteger(v) ? v : 0;
  return { uid, exp, v: version };
}

/** Ephemeral secret used when SESSION_SECRET is not configured. */
export function randomSecret(): string {
  return randomBytes(32).toString('hex');
}
