import { afterEach, describe, expect, it } from 'vitest';
import { download, randomBuffer, sha256Hex, startHarness, uploadBytes } from './helpers.ts';
import type { TestHarness } from './helpers.ts';

const SIZE = 32 * 1024 * 1024; // 3 parts: 15 + 15 + 2 MB

const harnesses: TestHarness[] = [];

async function harness(): Promise<TestHarness> {
  const h = await startHarness();
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

describe('integrity: checksum verification and part ordering', () => {
  it('returns a clean 500 when the first part checksum is corrupted', async () => {
    const h = await harness();
    const original = randomBuffer(SIZE);
    const { id } = await uploadBytes(h.baseUrl, original, 'corrupt-first.bin', h.cookie);

    await h.db.corruptChecksum(Number(id), 0);

    const res = await fetch(`${h.baseUrl}/api/files/${id}/download`, { headers: { cookie: h.cookie } });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('checksum');
  });

  it('aborts the stream when a later part checksum is corrupted', async () => {
    const h = await harness();
    const original = randomBuffer(SIZE);
    const { id } = await uploadBytes(h.baseUrl, original, 'corrupt-late.bin', h.cookie);

    await h.db.corruptChecksum(Number(id), 2); // last part

    const res = await fetch(`${h.baseUrl}/api/files/${id}/download`, { headers: { cookie: h.cookie } });
    expect(res.status).toBe(200);
    let bytes = 0;
    let errored = false;
    try {
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
      }
    } catch {
      errored = true;
    }
    // parts 0-1 may have been delivered, but the corrupted part must never be.
    expect(bytes).toBeLessThan(original.length);
    expect(errored || bytes > 0).toBe(true);
  });

  it('emits parts strictly in part_index order (reassembly follows the index)', async () => {
    const h = await harness();
    const original = randomBuffer(SIZE);
    const { id } = await uploadBytes(h.baseUrl, original, 'ordered.bin', h.cookie);

    // Swap part_index 0 <-> 1 in the DB. The download must order rows by
    // part_index, so the output becomes part1+part0+part2 (byte-exact).
    const PART = 15 * 1024 * 1024;
    await h.db.swapPartIndices(Number(id), 0, 1);

    const dl = await download(h.baseUrl, id, h.cookie);
    expect(dl.status).toBe(200);
    const expected = Buffer.concat([
      original.subarray(PART, 2 * PART),
      original.subarray(0, PART),
      original.subarray(2 * PART),
    ]);
    expect(sha256Hex(dl.buffer)).toBe(sha256Hex(expected));
  });

  it('rejects a download with 500 when part 0 is missing from storage', async () => {
    const h = await harness();
    const original = randomBuffer(SIZE);
    const { id } = await uploadBytes(h.baseUrl, original, 'missing.bin', h.cookie);

    // Remove the stored blob for part 0 from the mock Telegram store.
    const parts = await h.db.getPartsForFile(Number(id));
    await h.tg.deleteBlob(parts[0]!.tg_file_id);

    const res = await fetch(`${h.baseUrl}/api/files/${id}/download`, { headers: { cookie: h.cookie } });
    expect(res.status).toBe(500);
  });
});
