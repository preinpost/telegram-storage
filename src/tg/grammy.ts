import { randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { TgApiError } from '../errors.ts';
import type { SendDocumentInput, SendDocumentResult, TgClient } from './types.ts';

const FILE_API_BASE = 'https://api.telegram.org/file/bot';

/**
 * Real Telegram client backed by the raw Bot API over HTTPS.
 *
 * sendDocument builds the multipart form itself and streams it in 256KB
 * slices, reporting real bytes-written progress — the app-level upload
 * progress bar therefore tracks the actual network transfer instead of a
 * time-based estimate. Retry/backoff (429 + 5xx) is handled by the app-level
 * RateLimitQueue; timeouts are enforced per request.
 */
export class GrammyTgClient implements TgClient {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async sendDocument(input: SendDocumentInput): Promise<SendDocumentResult> {
    const boundary = `----telegram-storage-${randomUUID()}`;
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="chat_id"\r\n\r\n${input.chatId}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="document"; filename="${input.fileName.replace(/["\\\r\n]/g, '_')}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const total = head.length + input.data.length + tail.length;

    const result = await this.request(
      'sendDocument',
      total,
      head,
      input.data,
      tail,
      input.onProgress,
    );
    const doc = result.document as { file_id?: string } | undefined;
    const fileId = doc?.file_id;
    if (!fileId) {
      throw new TgApiError(500, 'Telegram response did not contain document.file_id');
    }
    return { messageId: Number(result.message_id), fileId };
  }

  async getFile(fileId: string): Promise<Buffer> {
    try {
      const res = await fetch(`${FILE_API_BASE}${this.token}/${fileId}`);
      if (!res.ok) {
        throw new TgApiError(res.status, `Telegram file metadata lookup failed with HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        ok?: boolean;
        result?: { file_path?: string };
        error_code?: number;
        description?: string;
      };
      if (!json.ok || !json.result?.file_path) {
        throw new TgApiError(
          json.error_code ?? 500,
          json.description ?? `Telegram did not return a file_path for file_id`,
        );
      }
      const blob = await fetch(`${FILE_API_BASE}${this.token}/${json.result.file_path}`);
      if (!blob.ok) {
        throw new TgApiError(blob.status, `Telegram file download failed with HTTP ${blob.status}`);
      }
      return Buffer.from(await blob.arrayBuffer());
    } catch (err) {
      throw toTgApiError(err);
    }
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    try {
      const body = JSON.stringify({ chat_id: chatId, message_id: messageId });
      const res = await fetch(`https://api.telegram.org/bot${this.token}/deleteMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      const json = (await res.json()) as { ok?: boolean; error_code?: number; description?: string };
      if (!json.ok) {
        throw new TgApiError(json.error_code ?? res.status, json.description ?? 'Telegram API error');
      }
    } catch (err) {
      throw toTgApiError(err);
    }
  }

  /**
   * POST a multipart body (head + data + tail) to a Bot API method, streaming
   * in 256KB slices and reporting progress for the data section.
   */
  private request(
    method: string,
    contentLength: number,
    head: Buffer,
    data: Buffer,
    tail: Buffer,
    onProgress?: (sentBytes: number) => void,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const url = `https://api.telegram.org/bot${this.token}/${method}`;
      const req = httpsRequest(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'multipart/form-data; boundary=' + head.slice(2, head.indexOf('\r\n')),
            'Content-Length': String(contentLength),
          },
          timeout: 60_000,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            let json: { ok?: boolean; error_code?: number; description?: string; result?: Record<string, unknown>; parameters?: { retry_after?: number } };
            try {
              json = JSON.parse(body) as typeof json;
            } catch {
              reject(
                new TgApiError(res.statusCode ?? 500, `Telegram returned non-JSON: ${body.slice(0, 200)}`),
              );
              return;
            }
            if (!json.ok) {
              reject(
                new TgApiError(
                  json.error_code ?? res.statusCode ?? 500,
                  json.description ?? 'Telegram API error',
                  json.parameters?.retry_after,
                ),
              );
              return;
            }
            resolve(json.result ?? {});
          });
        },
      );
      req.on('timeout', () => req.destroy(new TgApiError(504, 'Telegram upload timed out')));
      req.on('error', reject);

      const CHUNK = 256 * 1024;
      let headOff = 0;
      let dataOff = 0;
      let tailDone = false;
      const pump = (): void => {
        while (true) {
          if (!tailDone && headOff < head.length) {
            const slice = head.subarray(headOff, Math.min(headOff + CHUNK, head.length));
            headOff += slice.length;
            if (!req.write(slice)) return; // wait for drain
            continue;
          }
          if (!tailDone && dataOff < data.length) {
            const slice = data.subarray(dataOff, Math.min(dataOff + CHUNK, data.length));
            dataOff += slice.length;
            onProgress?.(dataOff);
            if (!req.write(slice)) return; // wait for drain
            continue;
          }
          if (!tailDone) {
            tailDone = true;
            req.end(tail);
            return;
          }
          return;
        }
      };
      req.on('drain', pump);
      pump();
    });
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
