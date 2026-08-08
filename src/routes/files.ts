import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppDeps, AppEnv } from '../app.ts';
import { requireAuth } from '../auth/middleware.ts';
import { rankOf, requireRole, resolveFileRole } from '../auth/permissions.ts';
import type { Db, FileRow } from '../db.ts';
import { openDownload } from '../download.ts';
import { HttpError } from '../errors.ts';
import { parseFilePart } from '../multipart.ts';
import { cleanupSpool, commitUpload, spoolUpload } from '../upload.ts';
import type { SpooledUpload } from '../upload.ts';

/**
 * File routes — all require authentication. Files live either at the root
 * (folder_id = NULL) or inside a folder; every operation is gated by the
 * caller's effective role on the containing folder.
 *
 *   GET    /                  list (folder_id=… or root) or search (?q=…)
 *   POST   /                  upload (multipart, folder_id optional)
 *   PATCH  /:id               move to another folder ({ folderId })
 *   GET    /:id/download      stream (checksum-verified, cache-aware)
 *   DELETE /:id               logical delete
 */
export function filesRoutes(deps: AppDeps, sessionSecret: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(sessionSecret, deps.db));

  app.get('/', async (c) => {
    const user = c.get('user');
    const q = c.req.query('q');
    if (q !== undefined && q !== '') {
      return c.json({ files: await searchFiles(deps, user.id, q, c.req.query('folder_id')) });
    }
    const raw = c.req.query('folder_id');
    let files: FileRow[];
    if (raw === undefined || raw === '') {
      files = await deps.db.listRootFiles();
    } else {
      const folderId = parseId(raw, 'folder_id');
      const folder = await deps.db.getFolder(folderId);
      if (!folder) throw new HttpError(404, 'folder not found');
      await requireRole(deps.db, user.id, folderId, 'read');
      files = await deps.db.listFilesInFolder(folderId);
    }
    return c.json({ files: files.map(toFileJson) });
  });

  app.post('/', async (c) => {
    const user = c.get('user');
    const { part: partPromise, done, fields } = parseFilePart(c.req.raw);
    // Parse errors surface via partPromise / done; never let them become
    // unhandled rejections.
    done.catch(() => undefined);
    const part = await partPromise;
    const name = sanitizeFileName(part.filename) || 'unnamed';

    const spool: SpooledUpload = await spoolUpload(deps.tmpDir, part.stream);
    // The spool belongs to the background commit once we hand it off; only
    // pre-handoff failures clean it up here.
    let handedOff = false;
    try {
      await done; // fields are now complete (incl. folder_id)
      const folderId = await folderIdFromFields(deps, user.id, fields);
      const now = Date.now();
      // Insert a pending row first and respond immediately: the Telegram
      // transfer runs in the background (commitUpload), and the client polls
      // the list until the file flips to 'ready'.
      const fileId = await deps.db.insertPendingFile(
        { name, size: spool.size, mime: part.mimeType || 'application/octet-stream', sha256: null },
        now,
        folderId,
        user.id,
      );
      handedOff = true;
      void commitUpload(
        deps,
        spool,
        {
          name,
          mime: part.mimeType || 'application/octet-stream',
          folderId,
          ownerId: user.id,
        },
        fileId,
      ).catch(() => undefined); // status is already set to 'failed' inside
      return c.json(
        {
          id: String(fileId),
          name,
          size: spool.size,
          mime: part.mimeType || 'application/octet-stream',
          folderId: folderId === null ? null : String(folderId),
          ownerId: String(user.id),
          status: 'uploading',
        },
        201,
      );
    } finally {
      if (!handedOff) {
        // Idempotent cleanup for pre-handoff failures only.
        await cleanupSpool(spool).catch(() => undefined);
      }
      part.stream.resume();
    }
  });

  app.get('/:id/download', async (c) => {
    const user = c.get('user');
    const id = parseFileId(c.req.param('id'));
    const file = await deps.db.getFile(id);
    if (!file || file.deleted_at !== null) throw new HttpError(404, 'file not found');
    // Only fully committed files can be downloaded.
    if (file.status !== 'ready') {
      throw new HttpError(file.status === 'failed' ? 410 : 409, `file is ${file.status}`);
    }
    if (rankOf(await resolveFileRole(deps.db, user, file.folder_id)) < rankOf('read')) {
      throw new HttpError(403, 'read permission required');
    }
    const dl = await openDownload(deps, id);
    return c.body(dl.stream, 200, {
      'Content-Type': dl.mime || 'application/octet-stream',
      'Content-Length': String(dl.size),
      'Content-Disposition': contentDisposition(dl.name),
    });
  });

  app.patch('/:id', async (c) => {
    const user = c.get('user');
    const id = parseFileId(c.req.param('id'));
    const file = await deps.db.getFile(id);
    if (!file || file.deleted_at !== null) throw new HttpError(404, 'file not found');
    // write on the source folder (root: members default write)
    if (rankOf(await resolveFileRole(deps.db, user, file.folder_id)) < rankOf('write')) {
      throw new HttpError(403, 'write permission required on the source folder');
    }
    const body = await readJson(c);
    if (!('folderId' in body)) {
      throw new HttpError(400, 'folderId is required');
    }
    const folderId = parseOptionalFolderId(body.folderId);
    if (folderId !== null) {
      const folder = await deps.db.getFolder(folderId);
      if (!folder) throw new HttpError(404, 'target folder not found');
      await requireRole(deps.db, user.id, folderId, 'write');
    }
    if (file.folder_id === folderId) {
      return c.json(toFileJson(file)); // no-op move
    }
    await deps.db.updateFileFolder(id, folderId, Date.now());
    return c.json(toFileJson((await deps.db.getFile(id))!));
  });

  app.delete('/:id', async (c) => {
    const user = c.get('user');
    const id = parseFileId(c.req.param('id'));
    const file = await deps.db.getFile(id);
    if (!file || file.deleted_at !== null) throw new HttpError(404, 'file not found');
    if (rankOf(await resolveFileRole(deps.db, user, file.folder_id)) < rankOf('write')) {
      throw new HttpError(403, 'write permission required');
    }
    await deps.db.markDeleted(id, Date.now());
    return c.body(null, 204);
  });

  return app;
}

/** Parses the multipart `folder_id` field and enforces the write gate. */
async function folderIdFromFields(
  deps: AppDeps,
  userId: number,
  fields: Record<string, string>,
): Promise<number | null> {
  const raw = fields['folder_id'];
  if (raw === undefined || raw === '') return null; // root: member default write
  const folderId = parseId(raw, 'folder_id');
  const folder = await deps.db.getFolder(folderId);
  if (!folder) throw new HttpError(404, 'folder not found');
  await requireRole(deps.db, userId, folderId, 'write');
  return folderId;
}

/**
 * Name-substring search with permission filtering.
 * - folder_id given → scope to that folder's subtree (read required on it)
 * - folder_id omitted → every active file the caller may read
 * Results include the containing folder path (root → folder).
 */
async function searchFiles(
  deps: AppDeps,
  userId: number,
  query: string,
  rawFolderId?: string,
): Promise<unknown[]> {
  let scopeFolderId: number | null = null;
  if (rawFolderId !== undefined && rawFolderId !== '') {
    scopeFolderId = parseId(rawFolderId, 'folder_id');
    const folder = await deps.db.getFolder(scopeFolderId);
    if (!folder) throw new HttpError(404, 'folder not found');
    await requireRole(deps.db, userId, scopeFolderId, 'read');
  }
  const user = await deps.db.getUserById(userId);
  if (!user) throw new HttpError(401, 'user not found');

  const files = await deps.db.searchFiles(query);
  const result: unknown[] = [];
  for (const file of files) {
    if (scopeFolderId !== null && !(await isInSubtree(deps.db, file.folder_id, scopeFolderId))) {
      continue;
    }
    if (rankOf(await resolveFileRole(deps.db, user, file.folder_id)) < rankOf('read')) {
      continue;
    }
    result.push({ ...toFileJson(file), folderPath: await folderPathOf(deps.db, file.folder_id) });
  }
  return result;
}

/** True when folderId is scopeId or one of its descendants. */
async function isInSubtree(db: Db, folderId: number | null, scopeId: number): Promise<boolean> {
  let cursor: number | null = folderId;
  for (let hop = 0; hop < 1000 && cursor !== null; hop++) {
    if (cursor === scopeId) return true;
    const current = await db.getFolder(cursor);
    cursor = current?.parent_id ?? null;
  }
  return false;
}

/** Root-to-folder path entries (empty array for root files). */
async function folderPathOf(
  db: Db,
  folderId: number | null,
): Promise<Array<{ id: string; name: string }>> {
  const path: Array<{ id: string; name: string }> = [];
  let cursor: number | null = folderId;
  for (let hop = 0; hop < 1000 && cursor !== null; hop++) {
    const folder = await db.getFolder(cursor);
    if (!folder) break;
    path.unshift({ id: String(folder.id), name: folder.name });
    cursor = folder.parent_id;
  }
  return path;
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, 'invalid JSON body');
  });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'invalid JSON body');
  }
  return body as Record<string, unknown>;
}

function parseOptionalFolderId(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return parseId(String(raw), 'folderId');
}

function toFileJson(file: FileRow): Record<string, unknown> {
  return {
    id: String(file.id),
    name: file.name,
    size: file.size,
    mime: file.mime,
    folderId: file.folder_id === null ? null : String(file.folder_id),
    ownerId: file.owner_id === null ? null : String(file.owner_id),
    status: file.status,
    error: file.error,
    createdAt: new Date(file.created_at).toISOString(),
    updatedAt: new Date(file.updated_at).toISOString(),
  };
}

function parseFileId(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'invalid file id');
  return Number(raw);
}

function parseId(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `invalid ${label}`);
  return Number(raw);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[/\\\0]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 255);
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
