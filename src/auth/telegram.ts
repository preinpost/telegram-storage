import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Telegram Login Widget verification — pure function, no I/O, unit-testable.
 *
 * Algorithm (as documented by Telegram):
 *   1. data_check_string = all received fields EXCEPT `hash`, sorted by key
 *      alphabetically, joined as `key=value` with `\n`
 *   2. secret_key = SHA256(bot_token)   (raw digest bytes)
 *   3. expected    = HMAC-SHA256(secret_key, data_check_string), hex-encoded
 *   4. accept iff expected === received hash (constant-time compare)
 *   5. `auth_date` must be within `maxAgeSeconds` of `nowSeconds`
 */
export const TELEGRAM_AUTH_MAX_AGE_SECONDS = 24 * 60 * 60;
/** Small forward skew allowance so a slightly-ahead client clock still works. */
const FUTURE_SKEW_SECONDS = 60;

export interface TelegramIdentity {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  photo_url?: string;
  auth_date: number;
}

export type TelegramAuthResult =
  | { ok: true; user: TelegramIdentity }
  | { ok: false; reason: string };

export function verifyTelegramAuth(
  params: Record<string, string | undefined>,
  botToken: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  maxAgeSeconds: number = TELEGRAM_AUTH_MAX_AGE_SECONDS,
): TelegramAuthResult {
  const hash = params['hash'];
  if (!hash) return { ok: false, reason: 'missing hash field' };

  const dataCheckString = Object.entries(params)
    .filter(([key, value]) => key !== 'hash' && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (!safeEqualHex(hash, expected)) {
    return { ok: false, reason: 'signature verification failed' };
  }

  const authDateRaw = params['auth_date'];
  if (authDateRaw === undefined || !/^\d+$/.test(authDateRaw)) {
    return { ok: false, reason: 'missing or invalid auth_date' };
  }
  const authDate = Number(authDateRaw);
  if (authDate < nowSeconds - maxAgeSeconds || authDate > nowSeconds + FUTURE_SKEW_SECONDS) {
    return { ok: false, reason: 'auth_date is expired or in the future' };
  }

  const idRaw = params['id'];
  if (idRaw === undefined || !/^\d+$/.test(idRaw)) {
    return { ok: false, reason: 'missing or invalid user id' };
  }

  return {
    ok: true,
    user: {
      id: Number(idRaw),
      username: params['username'],
      first_name: params['first_name'],
      last_name: params['last_name'],
      photo_url: params['photo_url'],
      auth_date: authDate,
    },
  };
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-fA-F]+$/.test(a) || !/^[0-9a-fA-F]+$/.test(b)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
