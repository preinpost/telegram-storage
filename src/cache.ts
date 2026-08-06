import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

/**
 * Opt-in local disk cache for downloaded files (see download.ts).
 *
 * Keyed by the full-file sha256 (stored at upload time), so identical content
 * is cached once. `get` refreshes the file's mtime (LRU proxy); `set` evicts
 * oldest files until the directory fits under `maxBytes`. Everything is
 * best-effort: any I/O failure degrades to a cache miss / skipped write, and
 * the cached bytes are never trusted without the per-part checksum path that
 * produced them.
 */
export interface DownloadCache {
  get(key: string): Promise<Buffer | null>;
  set(key: string, data: Buffer): Promise<void>;
}

export class DiskCache implements DownloadCache {
  private readonly dir: string;
  private readonly maxBytes: number;

  constructor(dir: string, maxBytes: number) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    void fsp.mkdir(dir, { recursive: true }).catch(() => undefined);
  }

  async get(key: string): Promise<Buffer | null> {
    const path = this.pathOf(key);
    try {
      const buf = await fsp.readFile(path);
      // Touch the file so LRU eviction keeps recently used entries.
      const now = new Date();
      await fsp.utimes(path, now, now).catch(() => undefined);
      return buf;
    } catch {
      return null;
    }
  }

  async set(key: string, data: Buffer): Promise<void> {
    try {
      await fsp.writeFile(this.pathOf(key), data);
    } catch {
      return; // cache write is best-effort
    }
    await this.evictIfOverBudget();
  }

  private pathOf(key: string): string {
    return join(this.dir, `${key}.bin`);
  }

  private async evictIfOverBudget(): Promise<void> {
    try {
      const entries = await Promise.all(
        (await fsp.readdir(this.dir))
          .filter((name) => name.endsWith('.bin'))
          .map(async (name) => {
            const stat = await fsp.stat(join(this.dir, name));
            return { name, size: stat.size, mtimeMs: stat.mtimeMs };
          }),
      );
      let total = entries.reduce((sum, e) => sum + e.size, 0);
      if (total <= this.maxBytes) return;
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
      for (const entry of entries) {
        if (total <= this.maxBytes) break;
        await fsp.rm(join(this.dir, entry.name), { force: true }).catch(() => undefined);
        total -= entry.size;
      }
    } catch {
      // eviction is best-effort
    }
  }
}
