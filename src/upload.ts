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
 * In-memory transfer progress for background uploads. Populated by
 * commitUpload (real bytes-reported by the Telegram client), read by the
 * list route. Volatile by design: on restart, stale 'uploading' files are
 * marked failed anyway.
 */
export interface UploadProgress {
  /** Parts fully sent to Telegram. */
  sent: number;
  /** Total parts for this file. */
  total: number;
  /** Bytes of the in-flight part already sent (0..activePartSize). */
  activeBytes: number;
  /** Size of the in-flight part. */
  activePartSize: number;
}

export const uploadProgress = new Map<number, UploadProgress>();

/**
 * 0–100 percent for the list UI: confirmed parts plus the real byte share of
 * the in-flight part, so the bar tracks the actual network transfer.
 */
export function transferPercent(prog: UploadProgress): number {
  if (prog.total <= 0) return 0;
  let parts = prog.sent;
  if (prog.sent < prog.total && prog.activePartSize > 0) {
    parts += Math.min(1, prog.activeBytes / prog.activePartSize);
  }
  return Math.min(100, Math.round((parts / prog.total) * 100));
}

/**
 * Phase 2 (background): split the spooled body into fixed 15MB slices, send
 * each via the rate-limit queue, then persist parts + flip the file to
 * 'ready'. Runs after the HTTP handler has already inserted a pending
 * ('uploading') files row and responded, so the client sees the file in the
 * list immediately.
 *
 * On failure the file is marked 'failed' and every part already sent to
 * Telegram is deleted (best-effort deleteMessage), so the chat stays clean
 * and the DB never references missing parts. The spool directory is removed
 * in all cases.
 */
export async function commitUpload(
  deps: UploadServiceDeps,
  spool: SpooledUpload,
  input: UploadInput,
  fileId: number,
): Promise<UploadResult> {
  if (!deps.chatId) {
    const msg = 'STORAGE_CHAT_ID is not configured';
    await deps.db.markFileStatus(fileId, 'failed', msg);
    await cleanupSpool(spool);
    throw new HttpError(500, msg);
  }
  const sent: SentPart[] = [];
  const totalParts = Math.max(1, Math.ceil(spool.size / CHUNK_SIZE));
  uploadProgress.set(fileId, { sent: 0, total: totalParts, activeBytes: 0, activePartSize: 0 });
  try {
    const fd = await fsp.open(spool.bodyPath, 'r');
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
        const prog = uploadProgress.get(fileId);
        if (prog) {
          prog.activeBytes = 0;
          prog.activePartSize = partSize;
        }
        const { messageId: tgMessageId, fileId: tgFileId } = await deps.queue.run(() =>
          deps.tg.sendDocument({
            chatId: deps.chatId as string,
            fileName: `${input.name}.part${partIndex}`,
            data: buf,
            // Real network progress — the list UI reflects the actual transfer.
            onProgress: (sentBytes) => {
              const p = uploadProgress.get(fileId);
              if (p) p.activeBytes = sentBytes;
            },
          }),
        );
        if (prog) {
          prog.sent = partIndex + 1;
          prog.activeBytes = 0;
          prog.activePartSize = 0;
        }
        sent.push({
          partIndex,
          offset,
          partSize,
          checksum,
          tgMessageId: tgMessageId,
          tgChatId: deps.chatId as string,
          tgFileId: tgFileId,
        });
        offset += partSize;
        partIndex++;
      }
    } finally {
      await fd.close();
    }

    const now = Date.now();
    await deps.db.insertPartsFor(fileId, sent, now);
    await deps.db.updateFileSha256(fileId, fileHash.digest('hex'), now);
    await deps.db.markFileStatus(fileId, 'ready', null, now);
    return { id: fileId, name: input.name, size: spool.size, mime: input.mime, partCount: sent.length };
  } catch (err) {
    console.error(`[upload] file #${fileId} commit failed:`, err instanceof Error ? err.message : err);
    // Roll back parts already stored in Telegram (best-effort, newest first)
    // so a failed upload leaves no orphan chunks behind.
    await rollbackSentParts(deps, sent);
    const reason = err instanceof Error ? err.message : String(err);
    await deps.db.markFileStatus(fileId, 'failed', reason.slice(0, 500));
    throw err;
  } finally {
    uploadProgress.delete(fileId);
    await cleanupSpool(spool);
  }
}

/** Deletes already-sent chunks from Telegram (newest first). Failures are ignored. */
async function rollbackSentParts(deps: UploadServiceDeps, sent: SentPart[]): Promise<void> {
  for (let i = sent.length - 1; i >= 0; i--) {
    const part = sent[i]!;
    try {
      await deps.queue.run(() => deps.tg.deleteMessage(part.tgChatId, part.tgMessageId));
    } catch {
      // Best-effort: a leftover message is preferable to blocking the rollback.
    }
  }
}
