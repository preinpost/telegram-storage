import { afterEach, describe, expect, it } from 'vitest';
import { download, formData, randomBuffer, sha256Hex, startHarness, uploadBytes } from './helpers.ts';
import type { TestHarness } from './helpers.ts';

// >15MB on purpose: forces multi-chunk (3 × 15MB) splitting/reassembly.
const BIG_SIZE = 36 * 1024 * 1024 + 123;

const harnesses: TestHarness[] = [];

async function harness(): Promise<TestHarness> {
  const h = await startHarness();
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

describe('upload / download roundtrip (mock Telegram)', () => {
  it('round-trips a >15MB random file with matching sha256', async () => {
    const h = await harness();
    const original = randomBuffer(BIG_SIZE);

    const uploaded = await uploadBytes(h.baseUrl, original, 'big.bin');
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.size).toBe(BIG_SIZE);
    expect(uploaded.body.partCount).toBe(3); // 36MB → 3 × 15MB chunks
    expect(uploaded.id).toMatch(/^\d+$/);

    const dl = await download(h.baseUrl, uploaded.id);
    expect(dl.status).toBe(200);
    expect(dl.buffer.length).toBe(BIG_SIZE);
    expect(sha256Hex(dl.buffer)).toBe(sha256Hex(original));
  });

  it('round-trips a small single-chunk file', async () => {
    const h = await harness();
    const original = randomBuffer(1024 * 1024);

    const uploaded = await uploadBytes(h.baseUrl, original, 'small.txt');
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.partCount).toBe(1);

    const dl = await download(h.baseUrl, uploaded.id);
    expect(dl.status).toBe(200);
    expect(sha256Hex(dl.buffer)).toBe(sha256Hex(original));
  });

  it('sets correct download headers (content-type/length/disposition)', async () => {
    const h = await harness();
    const uploaded = await uploadBytes(h.baseUrl, randomBuffer(1024), 'hello.txt');

    const res = await fetch(`${h.baseUrl}/api/files/${uploaded.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-length')).toBe('1024');
    expect(res.headers.get('content-disposition')).toContain('hello.txt');
  });

  it('lists uploaded files without leaking telegram identifiers', async () => {
    const h = await harness();
    await uploadBytes(h.baseUrl, randomBuffer(2048), 'a.bin');

    const res = await fetch(`${h.baseUrl}/api/files`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Array<Record<string, unknown>> };
    expect(body.files).toHaveLength(1);
    const file = body.files[0]!;
    expect(file.name).toBe('a.bin');
    expect(file.size).toBe(2048);
    expect('tg_file_id' in file).toBe(false);
    expect('tg_message_id' in file).toBe(false);
    expect('tg_chat_id' in file).toBe(false);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('mock-file-');
    expect(raw).not.toContain('tg_');
  });

  it('never exposes tg_file_id in download headers either', async () => {
    const h = await harness();
    const uploaded = await uploadBytes(h.baseUrl, randomBuffer(4096), 'secret.bin');

    const res = await fetch(`${h.baseUrl}/api/files/${uploaded.id}/download`);
    const headerText = [...res.headers.entries()].map(([, v]) => v).join('\n');
    expect(headerText).not.toContain('mock-file-');
    expect(headerText).not.toContain('bot');
  });

  it('returns 404 for unknown files', async () => {
    const h = await harness();
    const res = await fetch(`${h.baseUrl}/api/files/999/download`);
    expect(res.status).toBe(404);
  });

  it('rejects non-multipart uploads and empty files', async () => {
    const h = await harness();
    const jsonRes = await fetch(`${h.baseUrl}/api/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"x":1}',
    });
    expect(jsonRes.status).toBe(400);

    const emptyRes = await fetch(`${h.baseUrl}/api/files`, {
      method: 'POST',
      body: formData(Buffer.alloc(0), 'empty.bin'),
    });
    expect(emptyRes.status).toBe(400);
  });

  it('exposes a health endpoint', async () => {
    const h = await harness();
    const res = await fetch(`${h.baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
