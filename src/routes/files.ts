import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import { openDownload } from '../download.ts';
import { HttpError } from '../errors.ts';
import { parseFilePart } from '../multipart.ts';
import { uploadFile } from '../upload.ts';

export function filesRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const files = deps.db.listActiveFiles();
    return c.json({
      files: files.map((f) => ({
        id: String(f.id),
        name: f.name,
        size: f.size,
        mime: f.mime,
        createdAt: new Date(f.created_at).toISOString(),
        updatedAt: new Date(f.updated_at).toISOString(),
      })),
    });
  });

  app.post('/', async (c) => {
    const { part: partPromise, done } = parseFilePart(c.req.raw);
    // Avoid unhandled rejections; parse errors surface via partPromise / the pipe.
    done.catch(() => undefined);
    const part = await partPromise;
    const name = sanitizeFileName(part.filename) || 'unnamed';
    try {
      const result = await uploadFile(deps, {
        name,
        mime: part.mimeType || 'application/octet-stream',
        source: part.stream,
      });
      await done;
      return c.json(
        {
          id: String(result.id),
          name: result.name,
          size: result.size,
          mime: result.mime,
          partCount: result.partCount,
        },
        201,
      );
    } finally {
      // If uploadFile failed before consuming the stream, keep draining so the
      // connection is released instead of hanging.
      part.stream.resume();
    }
  });

  app.get('/:id/download', async (c) => {
    const id = parseFileId(c.req.param('id'));
    const dl = await openDownload(deps, id);
    return c.body(dl.stream, 200, {
      'Content-Type': dl.mime || 'application/octet-stream',
      'Content-Length': String(dl.size),
      'Content-Disposition': contentDisposition(dl.name),
    });
  });

  app.delete('/:id', async (c) => {
    const id = parseFileId(c.req.param('id'));
    const file = deps.db.getFile(id);
    if (!file || file.deleted_at !== null) throw new HttpError(404, 'file not found');
    deps.db.markDeleted(id, Date.now());
    return c.body(null, 204);
  });

  return app;
}

function parseFileId(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'invalid file id');
  return Number(raw);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[/\\\0]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 255);
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
