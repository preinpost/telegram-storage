import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { TgApiError } from '../errors.ts';
import type { SendDocumentInput, SendDocumentResult, TgClient } from './types.ts';

export interface MockFailure {
  /** Zero-based index of the client call to fail (sendDocument and getFile share one counter). */
  atCallIndex: number;
  status: number;
  retryAfterSeconds?: number;
  message?: string;
}

export interface MockTgClientOptions {
  /** Directory where mock "Telegram" blobs are stored. */
  dir: string;
  /** Scripted failures used to exercise the retry/backoff queue and rollback paths. */
  failures?: MockFailure[];
}

export interface SendLogEntry {
  index: number;
  fileName: string;
  size: number;
  at: number;
}

/**
 * Token-less Telegram stand-in.
 *
 * `sendDocument` writes the payload to a local file and issues a synthetic
 * `file_id`; `getFile` reads it back. This lets the whole M1+M2 pipeline run
 * and be tested without a real bot.
 */
export class MockTgClient implements TgClient {
  private readonly dir: string;
  private readonly failures: MockFailure[];
  private callIndex = 0;
  private nextMessageId = 1;
  /** fileId → original fileName, for assertions. */
  public readonly stored = new Map<string, string>();
  /** Timestamped send log, for queue-timing assertions. */
  public readonly sendLog: SendLogEntry[] = [];
  /** messageId → fileId, to support deleteMessage rollback. */
  private readonly messages = new Map<number, string>();
  /** Deleted message ids (rollback assertions). */
  public readonly deletedMessages: number[] = [];

  /** Total number of client calls made (sendDocument + getFile). */
  get callCount(): number {
    return this.callIndex;
  }

  constructor(options: MockTgClientOptions) {
    this.dir = options.dir;
    this.failures = options.failures ?? [];
    mkdirSync(this.dir, { recursive: true });
  }

  async sendDocument(input: SendDocumentInput): Promise<SendDocumentResult> {
    const index = this.callIndex++;
    const failure = this.failures.find((f) => f.atCallIndex === index);
    if (failure) {
      throw new TgApiError(
        failure.status,
        failure.message ?? `mock failure at call #${index}`,
        failure.retryAfterSeconds,
      );
    }
    const fileId = `mock-file-${randomUUID()}`;
    // Record at execution start (synchronously) so queue-timing tests observe
    // the enforced start-to-start interval without write I/O jitter.
    const entry: SendLogEntry = { index, fileName: input.fileName, size: input.data.length, at: Date.now() };
    this.sendLog.push(entry);
    input.onProgress?.(input.data.length);
    await fsp.writeFile(join(this.dir, `${fileId}.bin`), input.data);
    this.stored.set(fileId, input.fileName);
    const messageId = this.nextMessageId++;
    this.messages.set(messageId, fileId);
    return { messageId, fileId };
  }

  async getFile(fileId: string): Promise<Buffer> {
    this.callIndex++;
    const blobPath = join(this.dir, `${fileId}.bin`);
    if (!existsSync(blobPath)) {
      throw new TgApiError(400, `mock getFile: unknown file_id ${fileId}`);
    }
    return fsp.readFile(blobPath);
  }

  /** Removes a stored blob (simulates data loss on the Telegram side). */
  async deleteBlob(fileId: string): Promise<void> {
    await fsp.rm(join(this.dir, `${fileId}.bin`), { force: true });
    this.stored.delete(fileId);
  }

  async deleteMessage(_chatId: string, messageId: number): Promise<void> {
    const fileId = this.messages.get(messageId);
    if (!fileId) return;
    this.messages.delete(messageId);
    this.deletedMessages.push(messageId);
    await this.deleteBlob(fileId);
  }
}
