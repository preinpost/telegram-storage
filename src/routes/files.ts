import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../app.ts';
import { requireAuth } from '../auth/middleware.ts';
import { rankOf, requireRole, resolveFileRole } from '../auth/permissions.ts';
import type { FileRow } from '../db.ts';
import { openDownload } from '../download.ts';
import { HttpError } from '../errors.ts';
import { parseFilePart } from '../multipart.ts';
import { cleanupSpool, commitUpload, spoolUpload } from '../upload.ts';
import type { SpooledUpload } from '../upload.ts';

/**
 * File routes — all require authentication. Files live either at the root
 * (folder_id = NULL) or inside a folder; every operation is gated by the
 * caller's effective role on the containing folder.
 */
export function filesRoutes(deps: AppDeps, sessionSecret: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(sessionSecret, deps.db));

  app.get('/', (c) => {
    const user = c.get('user');
    const raw = c.req.query('folder_id');
    let files: FileRow[];
    if (raw === undefined || raw === '') {
      files = deps.db.listRootFiles();
    } else {
      const folderId = parseId(raw, 'folder_id');
      const folder = deps.db.getFolder(folderId);
      if (!folder) throw new HttpError(404, 'folder not found');
      requireRole(deps.db, user.id, folderId, 'read');
      files = deps.db.listFilesInFolder(folderId);
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
    try {
      await done; // fields are now complete (incl. folder_id)
      const folderId = folderIdFromFields(deps, user.id, fields);
      const result = await commitUpload(deps, spool, {
        name,
        mime: part.mimeType || 'application/octet-stream',
        folderId,
        ownerId: user.id,
      });
      return c.json(
        {
          id: String(result.id),
          name: result.name,
          size: result.size,
          mime: result.mime,
          folderId: folderId === null ? null : String(folderId),
          ownerId: String(user.id),
          partCount: result.partCount,
        },
        201,
      );
    } finally {
      // Idempotent — commitUpload already removed the spool on success/failure.
      await cleanupSpool(spool).catch(() => undefined);
      part.stream.resume();
    }
  });

  app.get('/:id/download', async (c) => {
    const user = c.get('user');
    const id = parseFileId(c.req.param('id'));
    const file = deps.db.getFile(id);
    if (!file || file.deleted_at !== null) throw new HttpError(404, 'file not found');
    if (rankOf(resolveFileRole(deps.db, user, file.folder_id)) < rankOf('read')) {
      throw new HttpError(403, 'read permission required');
    }
    const dl = await openDownload(deps, id);
    return c.body(dl.stream, 200, {
      'Content-Type': dl.mime || 'application/octet-stream',
      'Content-Length': String(dl.size),
      'Content-Disposition': contentDisposition(dl.name),
    });
  });

  app.delete('/:id', (c) => {
    const user = c.get('user');
    const id = parseFileId(c.req.param('id'));
    const file = deps.db.getFile(id);
    if (!file || file.deleted_at !== null) throw new HttpError(404, 'file not found');
    if (rankOf(resolveFileRole(deps.db, user, file.folder_id)) < rankOf('write')) {
      throw new HttpError(403, 'write permission required');
    }
    deps.db.markDeleted(id, Date.now());
    return c.body(null, 204);
  });

  return app;
}

/** Parses the multipart `folder_id` field and enforces the write gate. */
function folderIdFromFields(
  deps: AppDeps,
  userId: number,
  fields: Record<string, string>,
): number | null {
  const raw = fields['folder_id'];
  if (raw === undefined || raw === '') return null; // root: member default write
  const folderId = parseId(raw, 'folder_id');
  const folder = deps.db.getFolder(folderId);
  if (!folder) throw new HttpError(404, 'folder not found');
  requireRole(deps.db, userId, folderId, 'write');
  return folderId;
}

function toFileJson(file: FileRow): Record<string, unknown> {
  return {
    id: String(file.id),
    name: file.name,
    size: file.size,
    mime: file.mime,
    folderId: file.folder_id === null ? null : String(file.folder_id),
    ownerId: file.owner_id === null ? null : String(file.owner_id),
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
