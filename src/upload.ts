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
  /** Node readable stream of the file bytes (e.g. the busboy file stream). */
  source: Readable;
}

export interface UploadResult {
  id: number;
  name: string;
  size: number;
  mime: string;
  partCount: number;
}

interface SentPart extends NewPart {}

/**
 * Upload pipeline:
 *   1. stream the request body to a temp file on disk (memory-safe)
 *   2. split it into fixed 15MB slices, read one buffer at a time
 *   3. send each slice via the rate-limit queue, collecting tg_file_id/tg_message_id
 *   4. only after ALL chunks succeeded, commit files + parts in one transaction
 *   5. clean up the temp directory in all cases
 *
 * On failure nothing is ever committed: no files row, no parts rows (the
 * already-sent Telegram messages become orphans — inherent to the design).
 */
export async function uploadFile(deps: UploadServiceDeps, input: UploadInput): Promise<UploadResult> {
  if (!deps.chatId) {
    throw new HttpError(500, 'STORAGE_CHAT_ID is not configured');
  }
  await fsp.mkdir(deps.tmpDir, { recursive: true });
  const workDir = await fsp.mkdtemp(join(deps.tmpDir, 'upload-'));
  const bodyPath = join(workDir, 'body.bin');
  try {
    const size = await pipeToFile(input.source, bodyPath);
    if (size === 0) throw new HttpError(400, 'uploaded file is empty');

    const fd = await fsp.open(bodyPath, 'r');
    const sent: SentPart[] = [];
    try {
      let offset = 0;
      let partIndex = 0;
      while (offset < size) {
        const partSize = Math.min(CHUNK_SIZE, size - offset);
        const buf = Buffer.allocUnsafe(partSize);
        const { bytesRead } = await fd.read(buf, 0, partSize, offset);
        if (bytesRead !== partSize) {
          throw new HttpError(500, `short read while splitting file (part ${partIndex})`);
        }
        const checksum = sha256(buf);
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
      { name: input.name, size, mime: input.mime },
      sent,
      now,
    );
    return { id, name: input.name, size, mime: input.mime, partCount: sent.length };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}
