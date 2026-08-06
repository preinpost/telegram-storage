import { createHash } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function sha256(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Streams a node Readable into a file on disk, returning the number of bytes
 * written. Used for request-body spooling (memory-safe large uploads).
 */
export async function pipeToFile(source: Readable, destPath: string): Promise<number> {
  const dest = createWriteStream(destPath);
  await pipeline(source, dest);
  const { size } = await fsp.stat(destPath);
  return size;
}
