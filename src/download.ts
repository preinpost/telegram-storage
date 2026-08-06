import type { DownloadCache } from './cache.ts';
import type { Db, FileRow, PartRow } from './db.ts';
import { HttpError } from './errors.ts';
import type { RateLimitQueue } from './queue.ts';
import type { TgClient } from './tg/types.ts';
import { sha256 } from './util.ts';

export interface DownloadServiceDeps {
  db: Db;
  tg: TgClient;
  queue: RateLimitQueue;
  /** Optional disk cache; when set, downloads are cached by file sha256. */
  cache?: DownloadCache | null;
}

export class ChecksumError extends Error {
  constructor(
    public readonly fileId: number,
    public readonly partIndex: number,
  ) {
    super(`checksum mismatch for file ${fileId} part ${partIndex}`);
    this.name = 'ChecksumError';
  }
}

export interface DownloadResult {
  name: string;
  mime: string;
  size: number;
  stream: ReadableStream<Uint8Array>;
}

/**
 * Download pipeline:
 *   1. parts are read in part_index order
 *   2. each part is fetched from Telegram (through the rate-limit queue)
 *   3. each part's sha256 is verified against the stored checksum before it
 *      is emitted — a corrupt part aborts the stream
 *
 * Security: tg_file_id / tg_chat_id / tg_message_id and the token-bearing
 * file_path URL are used only inside this module and never appear in any
 * response. The first part is fetched and verified up front so a corrupt
 * first part surfaces as a clean 500 instead of a broken stream.
 *
 * Cache: when `deps.cache` is set and the file has a stored full-file sha256,
 * the download is assembled + verified once, stored under that key, and
 * subsequent requests stream from disk without touching Telegram. The cache is
 * opt-in (CACHE_DIR) and never skips the per-part checksum verification.
 */
export async function openDownload(
  deps: DownloadServiceDeps,
  fileId: number,
): Promise<DownloadResult> {
  const file = await deps.db.getFile(fileId);
  if (!file || file.deleted_at !== null) throw new HttpError(404, 'file not found');
  const parts = await deps.db.getPartsForFile(fileId);
  if (parts.length === 0) throw new HttpError(500, 'file has no stored parts');

  if (deps.cache && file.sha256) {
    const cached = await deps.cache.get(file.sha256);
    if (cached !== null) {
      return { name: file.name, mime: file.mime, size: file.size, stream: bufferToStream(cached) };
    }
    const assembled = await assembleAndVerify(deps, file, parts);
    if (assembled.length !== file.size) {
      throw new HttpError(500, 'downloaded file size mismatch');
    }
    await deps.cache.set(file.sha256, assembled);
    return { name: file.name, mime: file.mime, size: file.size, stream: bufferToStream(assembled) };
  }

  const first = await deps.queue.run(() => deps.tg.getFile(parts[0]!.tg_file_id));
  verifyPart(first, fileId, parts[0]!);

  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= parts.length) {
        controller.close();
        return;
      }
      let buf: Buffer;
      if (index === 0) {
        // Part 0 was already fetched + verified during preflight.
        buf = first;
      } else {
        const part = parts[index]!;
        try {
          buf = await deps.queue.run(() => deps.tg.getFile(part.tg_file_id));
          verifyPart(buf, fileId, part);
        } catch (err) {
          controller.error(err);
          return;
        }
      }
      controller.enqueue(buf);
      index++;
    },
  });

  return { name: file.name, mime: file.mime, size: file.size, stream };
}

/** Fetches every part through the queue and verifies each checksum. */
async function assembleAndVerify(
  deps: DownloadServiceDeps,
  _file: FileRow,
  parts: PartRow[],
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const buf = await deps.queue.run(() => deps.tg.getFile(part.tg_file_id));
    verifyPart(buf, _file.id, part);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function bufferToStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buf);
      controller.close();
    },
  });
}

function verifyPart(buf: Buffer, fileId: number, part: PartRow): void {
  if (sha256(buf) !== part.checksum) {
    throw new ChecksumError(fileId, part.part_index);
  }
}
