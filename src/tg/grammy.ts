import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Bot, InputFile } from 'grammy';
import { TgApiError } from '../errors.ts';
import type { SendDocumentInput, SendDocumentResult, TgClient } from './types.ts';

const FILE_API_BASE = 'https://api.telegram.org/file/bot';

/**
 * Real Telegram client backed by grammY.
 *
 * - `throttler` plugin: defensive per-chat ceilings (well above the app-level
 *   queue's 1 msg/sec, so it only ever kicks in as a safety net).
 * - `autoRetry` plugin: retries 429 (flood control, honoring `retry_after`)
 *   and transient 5xx errors inside grammY.
 * - The app-level RateLimitQueue additionally serializes every call and applies
 *   retry_after + exponential backoff, so behavior is identical for mock/real.
 */
export class GrammyTgClient implements TgClient {
  private readonly bot: Bot;
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
    this.bot = new Bot(token);
    this.bot.api.config.use(
      apiThrottler({
        global: { limit: 30, interval: 1000 },
        group: { limit: 20, interval: 60_000 },
        out: { limit: 20, interval: 60_000 },
      }),
    );
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 3 }));
  }

  async sendDocument(input: SendDocumentInput): Promise<SendDocumentResult> {
    try {
      const message = await this.bot.api.sendDocument(
        input.chatId,
        new InputFile(input.data, input.fileName),
      );
      const fileId = message.document?.file_id;
      if (!fileId) {
        throw new TgApiError(500, 'Telegram response did not contain document.file_id');
      }
      return { messageId: message.message_id, fileId };
    } catch (err) {
      throw toTgApiError(err);
    }
  }

  async getFile(fileId: string): Promise<Buffer> {
    let file: { file_path?: string };
    try {
      file = await this.bot.api.getFile(fileId);
    } catch (err) {
      throw toTgApiError(err);
    }
    if (!file.file_path) {
      throw new TgApiError(500, `Telegram did not return a file_path for file_id`);
    }
    // The file_path URL embeds the bot token — it must never leave this module.
    const res = await fetch(`${FILE_API_BASE}${this.token}/${file.file_path}`);
    if (!res.ok) {
      throw new TgApiError(res.status, `Telegram file download failed with HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

function toTgApiError(err: unknown): TgApiError {
  if (err instanceof TgApiError) return err;
  const e = err as {
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
  };
  return new TgApiError(
    e.error_code ?? 500,
    e.description ?? (err instanceof Error ? err.message : String(err)),
    e.parameters?.retry_after,
  );
}
