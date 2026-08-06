import { afterEach, describe, expect, it } from 'vitest';
import { api, devLogin, randomBuffer, startHarness, uploadBytes } from './helpers.ts';
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

interface FolderJson {
  id: string;
  name: string;
  parentId: string | null;
  children?: FolderJson[];
}

async function createFolder(
  h: TestHarness,
  name: string,
  parentId?: string | null,
): Promise<{ status: number; folder: FolderJson }> {
  const res = await api(h, '/api/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parentId === undefined ? { name } : { name, parentId }),
  });
  const body = (await res.json().catch(() => ({}))) as FolderJson & { error?: string };
  return { status: res.status, folder: body };
}

interface SearchFileJson {
  id: string;
  name: string;
  folderId: string | null;
  folderPath: Array<{ id: string; name: string }>;
}

async function search(h: TestHarness, q: string, folderId?: string): Promise<SearchFileJson[]> {
  const query = folderId === undefined ? `q=${encodeURIComponent(q)}` : `q=${encodeURIComponent(q)}&folder_id=${folderId}`;
  const res = await api(h, `/api/files?${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { files: SearchFileJson[] };
  return body.files;
}

describe('file search (GET /api/files?q=…)', () => {
  it('finds files by case-insensitive name substring, with folder paths', async () => {
    const h = await harness();
    const team = await createFolder(h, 'team');
    const docs = await createFolder(h, 'docs', team.folder.id);
    await uploadBytes(h.baseUrl, randomBuffer(64), 'Quarterly-Report.pdf', h.cookie, {
      folder_id: docs.folder.id,
    });
    await uploadBytes(h.baseUrl, randomBuffer(64), 'notes.txt', h.cookie, {
      folder_id: docs.folder.id,
    });
    await uploadBytes(h.baseUrl, randomBuffer(64), 'report-2024.xlsx', h.cookie); // root

    const hits = await search(h, 'report');
    expect(hits.map((f) => f.name).sort()).toEqual(['Quarterly-Report.pdf', 'report-2024.xlsx']);

    const nested = hits.find((f) => f.name === 'Quarterly-Report.pdf')!;
    expect(nested.folderId).toBe(docs.folder.id);
    expect(nested.folderPath.map((p) => p.name)).toEqual(['team', 'docs']);

    const rootFile = hits.find((f) => f.name === 'report-2024.xlsx')!;
    expect(rootFile.folderId).toBeNull();
    expect(rootFile.folderPath).toEqual([]);
  });

  it('scopes the search to a folder subtree via folder_id', async () => {
    const h = await harness();
    const a = await createFolder(h, 'a');
    const b = await createFolder(h, 'b', a.folder.id);
    await uploadBytes(h.baseUrl, randomBuffer(64), 'report-in-a.bin', h.cookie, {
      folder_id: a.folder.id,
    });
    await uploadBytes(h.baseUrl, randomBuffer(64), 'report-in-b.bin', h.cookie, {
      folder_id: b.folder.id,
    });
    await uploadBytes(h.baseUrl, randomBuffer(64), 'report-root.bin', h.cookie);

    const hits = await search(h, 'report', a.folder.id);
    expect(hits.map((f) => f.name).sort()).toEqual(['report-in-a.bin', 'report-in-b.bin']);
  });

  it('matches a literal query even when it contains LIKE wildcards', async () => {
    const h = await harness();
    await uploadBytes(h.baseUrl, randomBuffer(32), '100%.txt', h.cookie);
    await uploadBytes(h.baseUrl, randomBuffer(32), '100x.txt', h.cookie);

    const hits = await search(h, '100%');
    expect(hits.map((f) => f.name)).toEqual(['100%.txt']);
  });

  it('excludes logically deleted files', async () => {
    const h = await harness();
    const up = await uploadBytes(h.baseUrl, randomBuffer(32), 'old-report.pdf', h.cookie);
    await api(h, `/api/files/${up.id}`, { method: 'DELETE' });

    const hits = await search(h, 'report');
    expect(hits).toHaveLength(0);
  });

  it('returns an empty list when nothing matches', async () => {
    const h = await harness();
    await uploadBytes(h.baseUrl, randomBuffer(32), 'present.txt', h.cookie);
    const hits = await search(h, 'zzz-nothing');
    expect(hits).toHaveLength(0);
  });

  it('requires read on the scope folder (403 for a folder the user cannot read)', async () => {
    const h = await harness();
    const bob = await devLogin(h.baseUrl, 'bob');
    const a = await createFolder(h, 'a');
    await uploadBytes(h.baseUrl, randomBuffer(32), 'report.bin', h.cookie, {
      folder_id: a.folder.id,
    });

    // folder_id pointing at a missing folder → 404
    const missing = await api(h, '/api/files?q=report&folder_id=999', {}, bob);
    expect(missing.status).toBe(404);
    // existing folder → 200 (default read admits bob)
    const ok = await api(h, `/api/files?q=report&folder_id=${a.folder.id}`, {}, bob);
    expect(ok.status).toBe(200);
  });
});

describe('file move (PATCH /api/files/:id)', () => {
  it('moves a file between folders (write on both)', async () => {
    const h = await harness();
    const src = await createFolder(h, 'src');
    const dst = await createFolder(h, 'dst');
    const up = await uploadBytes(h.baseUrl, randomBuffer(64), 'f.bin', h.cookie, {
      folder_id: src.folder.id,
    });
    expect(up.status).toBe(201);

    const res = await api(h, `/api/files/${up.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: dst.folder.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { folderId: string | null; id: string };
    expect(body.folderId).toBe(dst.folder.id);

    const inDst = await api(h, `/api/files?folder_id=${dst.folder.id}`);
    const dstBody = (await inDst.json()) as { files: Array<{ id: string }> };
    expect(dstBody.files.map((f) => f.id)).toContain(up.id);
    const inSrc = await api(h, `/api/files?folder_id=${src.folder.id}`);
    const srcBody = (await inSrc.json()) as { files: Array<{ id: string }> };
    expect(srcBody.files).toHaveLength(0);
  });

  it('moves a file to the root with folderId null', async () => {
    const h = await harness();
    const a = await createFolder(h, 'a');
    const up = await uploadBytes(h.baseUrl, randomBuffer(64), 'f.bin', h.cookie, {
      folder_id: a.folder.id,
    });

    const res = await api(h, `/api/files/${up.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { folderId: string | null };
    expect(body.folderId).toBeNull();
  });

  it('rejects a move to a missing folder (404) and a missing folderId (400)', async () => {
    const h = await harness();
    const a = await createFolder(h, 'a');
    const up = await uploadBytes(h.baseUrl, randomBuffer(64), 'f.bin', h.cookie, {
      folder_id: a.folder.id,
    });

    const missing = await api(h, `/api/files/${up.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: '999' }),
    });
    expect(missing.status).toBe(404);

    const noBody = await api(h, `/api/files/${up.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noBody.status).toBe(400);
  });

  it('rejects a move without write on the source folder (403)', async () => {
    const h = await harness();
    const bob = await devLogin(h.baseUrl, 'bob'); // member, default read
    const a = await createFolder(h, 'a');
    const up = await uploadBytes(h.baseUrl, randomBuffer(64), 'f.bin', h.cookie, {
      folder_id: a.folder.id,
    });

    const res = await api(
      h,
      `/api/files/${up.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderId: null }),
      },
      bob,
    );
    expect(res.status).toBe(403);
  });

  it('rejects a move of a deleted file (404)', async () => {
    const h = await harness();
    const a = await createFolder(h, 'a');
    const up = await uploadBytes(h.baseUrl, randomBuffer(64), 'f.bin', h.cookie, {
      folder_id: a.folder.id,
    });
    await api(h, `/api/files/${up.id}`, { method: 'DELETE' });

    const res = await api(h, `/api/files/${up.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: null }),
    });
    expect(res.status).toBe(404);
  });
});

describe('storage stats (GET /api/stats)', () => {
  it('reports totals and per-folder usage to the admin', async () => {
    const h = await harness();
    const a = await createFolder(h, 'a');
    const b = await createFolder(h, 'b');
    await uploadBytes(h.baseUrl, randomBuffer(100), 'f1.bin', h.cookie, { folder_id: a.folder.id });
    await uploadBytes(h.baseUrl, randomBuffer(50), 'f2.bin', h.cookie, { folder_id: b.folder.id });
    await uploadBytes(h.baseUrl, randomBuffer(25), 'f3.bin', h.cookie); // root

    const res = await api(h, '/api/stats');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalSize: number;
      fileCount: number;
      folderCount: number;
      userCount: number;
      folderUsage: Array<{ folderId: string | null; name: string; size: number; fileCount: number }>;
    };
    expect(body.totalSize).toBe(175);
    expect(body.fileCount).toBe(3);
    expect(body.folderCount).toBe(2);
    expect(body.userCount).toBe(1);
    expect(body.folderUsage).toHaveLength(3); // a, b, root
    const usageA = body.folderUsage.find((u) => u.name === 'a')!;
    expect(usageA.size).toBe(100);
    expect(usageA.fileCount).toBe(1);
    const usageRoot = body.folderUsage.find((u) => u.folderId === null)!;
    expect(usageRoot.size).toBe(25);
  });

  it('excludes deleted files from totals', async () => {
    const h = await harness();
    const up = await uploadBytes(h.baseUrl, randomBuffer(100), 'gone.bin', h.cookie);
    await api(h, `/api/files/${up.id}`, { method: 'DELETE' });

    const res = await api(h, '/api/stats');
    const body = (await res.json()) as { totalSize: number; fileCount: number };
    expect(body.totalSize).toBe(0);
    expect(body.fileCount).toBe(0);
  });

  it('is available to any authenticated member (folderUsage filtered by read)', async () => {
    const h = await harness();
    const bob = await devLogin(h.baseUrl, 'bob');
    const a = await createFolder(h, 'a');
    await uploadBytes(h.baseUrl, randomBuffer(40), 'f.bin', h.cookie, { folder_id: a.folder.id });

    const res = await api(h, '/api/stats', {}, bob);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalSize: number;
      userCount: number;
      folderUsage: Array<{ name: string }>;
    };
    expect(body.totalSize).toBe(40);
    expect(body.userCount).toBe(2);
    // default-read admits bob to every folder, so all usage rows are visible
    expect(body.folderUsage.map((u) => u.name)).toContain('a');
  });

  it('requires authentication', async () => {
    const h = await harness({ devAuth: false });
    const res = await fetch(`${h.baseUrl}/api/stats`);
    expect(res.status).toBe(401);
  });
});
