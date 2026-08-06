import { afterEach, describe, expect, it } from 'vitest';
import { download, randomBuffer, startHarness, uploadBytes } from './helpers.ts';
import type { TestHarness } from './helpers.ts';

const harnesses: TestHarness[] = [];

async function harness(options?: Parameters<typeof startHarness>[0]): Promise<TestHarness> {
  const h = await startHarness(options);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

describe('download disk cache (CACHE_DIR)', () => {
  it('serves the second download from cache without touching Telegram', async () => {
    const h = await harness({ cacheDir: 'cache' });
    const up = await uploadBytes(h.baseUrl, randomBuffer(256), 'cached.bin', h.cookie);
    expect(up.status).toBe(201);

    const callsAfterUpload = h.tg.callCount;

    const first = await download(h.baseUrl, up.id, h.cookie);
    expect(first.status).toBe(200);
    expect(h.tg.callCount).toBeGreaterThan(callsAfterUpload); // fetched from tg

    const callsAfterFirst = h.tg.callCount;
    const second = await download(h.baseUrl, up.id, h.cookie);
    expect(second.status).toBe(200);
    expect(h.tg.callCount).toBe(callsAfterFirst); // cache hit — zero tg calls
    expect(second.buffer.equals(first.buffer)).toBe(true);
    expect(second.buffer.length).toBe(256);
  });

  it('still verifies per-part checksums on the cache-miss assembly path', async () => {
    const h = await harness({ cacheDir: 'cache' });
    const up = await uploadBytes(h.baseUrl, randomBuffer(64), 'corrupt.bin', h.cookie);
    await h.db.corruptChecksum(Number(up.id), 0);

    const dl = await download(h.baseUrl, up.id, h.cookie);
    expect(dl.status).toBe(500); // checksum mismatch aborts before caching
  });

  it('deduplicates identical content under one cache key', async () => {
    const h = await harness({ cacheDir: 'cache' });
    const data = randomBuffer(128);
    const a = await uploadBytes(h.baseUrl, data, 'copy-a.bin', h.cookie);
    const b = await uploadBytes(h.baseUrl, data, 'copy-b.bin', h.cookie);

    const callsAfterUpload = h.tg.callCount;
    await download(h.baseUrl, a.id, h.cookie); // populates cache (sha256 = data)
    const callsAfterFirst = h.tg.callCount;
    await download(h.baseUrl, b.id, h.cookie); // same content → cache hit
    expect(h.tg.callCount).toBe(callsAfterFirst);
    expect(h.tg.callCount).toBeGreaterThan(callsAfterUpload);
  });

  it('is disabled by default — every download hits Telegram', async () => {
    const h = await harness(); // no cacheDir
    const up = await uploadBytes(h.baseUrl, randomBuffer(256), 'plain.bin', h.cookie);

    const callsAfterUpload = h.tg.callCount;
    await download(h.baseUrl, up.id, h.cookie);
    const callsAfterFirst = h.tg.callCount;
    expect(callsAfterFirst).toBeGreaterThan(callsAfterUpload);

    await download(h.baseUrl, up.id, h.cookie);
    expect(h.tg.callCount).toBeGreaterThan(callsAfterFirst); // fetched again
  });
});
