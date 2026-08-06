import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { CHUNK_SIZE } from './config.ts';
import type { Db, NewPart } from './db.ts';
import { HttpError } from './errors.ts';
import type { RateLimitQueue } from './queue.ts';
import type { TgClient } from './tg/types.ts';
import { pipeToFile, sha256 } from './util.ts';

export interface UploadServiceDeps {
  db: Db;
  tg: TgClient;
  queue: RateLimitQueue;
  chatId: string | null;
  tmpDir: string;
}

export interface UploadInput {
  name: string;
  mime: string;
  /** Target folder id (NULL = root). Validated by the route before commit. */
  folderId: number | null;
  ownerId: number | null;
}

export interface UploadResult {
  id: number;
  name: string;
  size: number;
  mime: string;
  partCount: number;
}

/** A request body spooled to disk, ready to be split + sent. */
export interface SpooledUpload {
  workDir: string;
  bodyPath: string;
  size: number;
}

interface SentPart extends NewPart {}

/**
 * Phase 1: stream the request body to a temp file on disk (memory-safe).
 * The caller must call `done` (multipart body fully parsed) before committing,
 * so form fields such as `folder_id` are complete for validation.
 */
export async function spoolUpload(tmpDir: string, source: Readable): Promise<SpooledUpload> {
  await fsp.mkdir(tmpDir, { recursive: true });
  const workDir = await fsp.mkdtemp(join(tmpDir, 'upload-'));
  const bodyPath = join(workDir, 'body.bin');
  try {
    const size = await pipeToFile(source, bodyPath);
    if (size === 0) throw new HttpError(400, 'uploaded file is empty');
    return { workDir, bodyPath, size };
  } catch (err) {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/** Idempotent cleanup of a spooled upload (safe to call more than once). */
export async function cleanupSpool(spool: SpooledUpload): Promise<void> {
  await fsp.rm(spool.workDir, { recursive: true, force: true });
}

/**
 * Phase 2: split the spooled body into fixed 15MB slices, send each via the
 * rate-limit queue, and — only after ALL chunks succeeded — commit files +
 * parts in one transaction. On failure nothing is ever committed (no files
 * row, no parts rows); already-sent Telegram messages become orphans
 * (inherent to the design). The spool directory is removed in all cases.
 */
export async function commitUpload(
  deps: UploadServiceDeps,
  spool: SpooledUpload,
  input: UploadInput,
): Promise<UploadResult> {
  if (!deps.chatId) {
    throw new HttpError(500, 'STORAGE_CHAT_ID is not configured');
  }
  try {
    const fd = await fsp.open(spool.bodyPath, 'r');
    const sent: SentPart[] = [];
    const fileHash = createHash('sha256');
    try {
      let offset = 0;
      let partIndex = 0;
      while (offset < spool.size) {
        const partSize = Math.min(CHUNK_SIZE, spool.size - offset);
        const buf = Buffer.allocUnsafe(partSize);
        const { bytesRead } = await fd.read(buf, 0, partSize, offset);
        if (bytesRead !== partSize) {
          throw new HttpError(500, `short read while splitting file (part ${partIndex})`);
        }
        const checksum = sha256(buf);
        fileHash.update(buf); // cumulative full-file hash (download-cache key)
        const result = await deps.queue.run(() =>
          deps.tg.sendDocument({
            chatId: deps.chatId as string,
            fileName: `${input.name}.part${partIndex}`,
            data: buf,
          }),
        );
        sent.push({
          partIndex,
          offset,
          partSize,
          checksum,
          tgMessageId: result.messageId,
          tgChatId: deps.chatId as string,
          tgFileId: result.fileId,
        });
        offset += partSize;
        partIndex++;
      }
    } finally {
      await fd.close();
    }

    const now = Date.now();
    const id = deps.db.insertFileWithParts(
      { name: input.name, size: spool.size, mime: input.mime, sha256: fileHash.digest('hex') },
      sent,
      now,
      input.folderId,
      input.ownerId,
    );
    return { id, name: input.name, size: spool.size, mime: input.mime, partCount: sent.length };
  } finally {
    await cleanupSpool(spool);
  }
}
