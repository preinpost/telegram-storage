import { resolve } from 'node:path';

/**
 * Fixed chunk size (15 MiB).
 *
 * Telegram public Bot API limits: upload (sendDocument) 50MB, download
 * (getFile) 20MB — 15MB chunks stay comfortably under both, so no local
 * Bot API server is needed. Do not change.
 */
export const CHUNK_SIZE = 15 * 1024 * 1024;

export interface Config {
  /** Telegram bot token (from @BotFather). null → mock Telegram client. */
  botToken: string | null;
  /** Telegram bot username (from @BotFather), used by the Login Widget. null → widget hidden. */
  botUsername: string | null;
  /** Dedicated private channel/group chat id for storage. null → mock placeholder. */
  chatId: string | null;
  dbPath: string;
  tmpDir: string;
  queueIntervalMs: number;
  queueMaxRetries: number;
  queueBaseBackoffMs: number;
  queueMaxBackoffMs: number;
  port: number;
  host: string;
  /**
   * DEV_AUTH=true enables POST /api/auth/dev-login (username → session) for
   * local development / testing without a real Telegram login. Must stay off
   * in production.
   */
  devAuth: boolean;
  /** Secret signing session cookies. null → ephemeral secret (sessions die on restart). */
  sessionSecret: string | null;
  /** Login rate limit per minute (0 disables throttling). Default 10. */
  rateLimitPerMinute: number;
  /** Download-cache directory; empty → cache disabled. */
  cacheDir: string;
  /** Download-cache size cap in MiB (LRU eviction). Default 1024. */
  cacheMaxMb: number;
  /** Add the Secure flag to session cookies (deployments behind HTTPS). */
  cookieSecure: boolean;
}

function int(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label}: "${value}"`);
  return parsed;
}

/**
 * Loads configuration from the environment. A `.env` file is loaded
 * automatically if present (existing process.env values win, dotenv-style).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file — rely on process.env only
  }
  return {
    botToken: env.TELEGRAM_BOT_TOKEN?.trim() || null,
    botUsername: env.TELEGRAM_BOT_USERNAME?.trim() || null,
    chatId: env.STORAGE_CHAT_ID?.trim() || null,
    dbPath: resolve(env.DB_PATH || './data/telegram-storage.db'),
    tmpDir: resolve(env.TMP_DIR || './tmp'),
    queueIntervalMs: int(env.QUEUE_INTERVAL_MS, 1000, 'QUEUE_INTERVAL_MS'),
    queueMaxRetries: int(env.QUEUE_MAX_RETRIES, 4, 'QUEUE_MAX_RETRIES'),
    queueBaseBackoffMs: int(env.QUEUE_BASE_BACKOFF_MS, 1000, 'QUEUE_BASE_BACKOFF_MS'),
    queueMaxBackoffMs: int(env.QUEUE_MAX_BACKOFF_MS, 60000, 'QUEUE_MAX_BACKOFF_MS'),
    port: int(env.PORT, 3000, 'PORT'),
    host: env.HOST || '0.0.0.0',
    devAuth: env.DEV_AUTH === 'true' || env.DEV_AUTH === '1',
    sessionSecret: env.SESSION_SECRET?.trim() || null,
    rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 10, 'RATE_LIMIT_PER_MINUTE'),
    cacheDir: env.CACHE_DIR?.trim() || '',
    cacheMaxMb: int(env.CACHE_MAX_MB, 1024, 'CACHE_MAX_MB'),
    cookieSecure: env.COOKIE_SECURE === 'true' || env.COOKIE_SECURE === '1',
  };
}
