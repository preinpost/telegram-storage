import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppDeps, AppEnv } from '../app.ts';
import { requireAuth } from '../auth/middleware.ts';
import {
  folderAdminUserIds,
  isAdminOn,
  rankOf,
  requireRole,
  resolveFolderRole,
} from '../auth/permissions.ts';
import type { Role } from '../auth/permissions.ts';
import type { Db, FolderRow, PermissionRow } from '../db.ts';
import { HttpError } from '../errors.ts';

/**
 * Folder CRUD + permission management.
 *
 *   GET    /api/folders                 tree (filtered by effective role >= read)
 *   POST   /api/folders                 create (parent needs >= write; root: member default write)
 *   PATCH  /api/folders/:id             rename / move (>= write on the folder; cycle + dup checks)
 *   DELETE /api/folders/:id             delete subtree (folder admin)
 *   GET    /api/folders/:id/permissions list grants (folder admin)
 *   POST   /api/folders/:id/permissions grant/update {userId, role} (folder admin)
 *   DELETE /api/folders/:id/permissions revoke ?userId= (folder admin)
 */
export function foldersRoutes(deps: AppDeps, sessionSecret: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(sessionSecret, deps.db));

  app.get('/', (c) => {
    const user = c.get('user');
    const all = deps.db.listFolders();

    // Filter by effective permission (>= read; with the default-read rule this
    // currently admits every folder for members) and build a tree.
    const byParent = new Map<number | null, FolderRow[]>();
    for (const folder of all) {
      if (rankOf(resolveFolderRole(deps.db, user.id, folder.id)) < rankOf('read')) continue;
      const siblings = byParent.get(folder.parent_id) ?? [];
      siblings.push(folder);
      byParent.set(folder.parent_id, siblings);
    }
    const build = (parentId: number | null): FolderJson[] =>
      (byParent.get(parentId) ?? []).map((folder) => ({
        ...folderJson(folder, resolveFolderRole(deps.db, user.id, folder.id)),
        children: build(folder.id),
      }));

    return c.json({ folders: build(null) });
  });

  app.post('/', async (c) => {
    const user = c.get('user');
    const body = await readJson(c);
    const name = sanitizeFolderName(body.name);
    const parentId = parseOptionalId(body.parentId, 'parentId');

    if (parentId !== null) {
      const parent = deps.db.getFolder(parentId);
      if (!parent) throw new HttpError(404, 'parent folder not found');
      requireRole(deps.db, user.id, parentId, 'write');
    }
    assertNoDuplicateSibling(deps.db, name, parentId);

    const now = Date.now();
    const id = deps.db.createFolder(name, parentId, user.id, now);
    const folder = deps.db.getFolder(id)!;
    return c.json(folderJson(folder, resolveFolderRole(deps.db, user.id, id)), 201);
  });

  app.patch('/:id', async (c) => {
    const user = c.get('user');
    const id = parseId(c.req.param('id'), 'folder id');
    const folder = deps.db.getFolder(id);
    if (!folder) throw new HttpError(404, 'folder not found');
    requireRole(deps.db, user.id, id, 'write');

    const body = await readJson(c);
    const changes: { name?: string; parentId?: number | null } = {};

    if (body.name !== undefined) {
      changes.name = sanitizeFolderName(body.name);
      assertNoDuplicateSibling(deps.db, changes.name, folder.parent_id, id);
    }
    if (body.parentId !== undefined) {
      const newParentId =
        body.parentId === null || body.parentId === '' ? null : parseId(body.parentId, 'parentId');
      if (newParentId !== null) {
        if (newParentId === id) throw new HttpError(400, 'a folder cannot be moved into itself');
        const parent = deps.db.getFolder(newParentId);
        if (!parent) throw new HttpError(404, 'parent folder not found');
        // Cycle prevention: the new parent must not live inside this folder's subtree.
        let cursor: number | null = newParentId;
        for (let hop = 0; hop < 1000 && cursor !== null; hop++) {
          if (cursor === id) {
            throw new HttpError(400, 'a folder cannot be moved into its own subtree');
          }
          const current = deps.db.getFolder(cursor);
          cursor = current?.parent_id ?? null;
        }
        requireRole(deps.db, user.id, newParentId, 'write');
        assertNoDuplicateSibling(deps.db, folder.name, newParentId, id);
      }
      changes.parentId = newParentId;
    }

    if (Object.keys(changes).length === 0) throw new HttpError(400, 'nothing to update');
    deps.db.updateFolder(id, changes);
    const updated = deps.db.getFolder(id)!;
    return c.json(folderJson(updated, resolveFolderRole(deps.db, user.id, id)));
  });

  app.delete('/:id', (c) => {
    const user = c.get('user');
    const id = parseId(c.req.param('id'), 'folder id');
    const folder = deps.db.getFolder(id);
    if (!folder) throw new HttpError(404, 'folder not found');
    if (!isAdminOn(deps.db, user.id, id)) {
      throw new HttpError(403, 'admin permission required on this folder');
    }
    const subtree = deps.db.folderSubtreeIds(id);
    deps.db.deleteFolderSubtree(id, subtree, Date.now());
    return c.body(null, 204);
  });

  // ---- permissions --------------------------------------------------------

  app.get('/:id/permissions', (c) => {
    const user = c.get('user');
    const id = parseId(c.req.param('id'), 'folder id');
    assertFolderAdmin(deps.db, user.id, id);
    const permissions = deps.db.listPermissions(id);
    return c.json({ permissions: permissions.map(permissionJson) });
  });

  app.post('/:id/permissions', async (c) => {
    const user = c.get('user');
    const id = parseId(c.req.param('id'), 'folder id');
    const folder = assertFolderAdmin(deps.db, user.id, id);

    const body = await readJson(c);
    const userId = parseId(body.userId, 'userId');
    const role = typeof body.role === 'string' ? body.role : '';
    if (!isRole(role)) {
      throw new HttpError(400, 'role must be one of: read, write, admin');
    }
    const target = deps.db.getUserById(userId);
    if (!target) throw new HttpError(404, 'user not found');
    if (folder.owner_id === userId) {
      throw new HttpError(400, 'folder owner is always admin');
    }

    const existing = deps.db.getPermission('user', userId, id);
    if (existing?.role === 'admin' && role !== 'admin') {
      if (userId === user.id) {
        throw new HttpError(403, 'cannot demote your own admin permission');
      }
      assertAdminRemains(deps.db, id, userId);
    }

    const row = deps.db.upsertPermission('user', userId, id, role, Date.now());
    return c.json({ permission: permissionJson(row) }, existing ? 200 : 201);
  });

  app.delete('/:id/permissions', (c) => {
    const user = c.get('user');
    const id = parseId(c.req.param('id'), 'folder id');
    const folder = assertFolderAdmin(deps.db, user.id, id);

    const rawUserId = c.req.query('userId');
    if (!rawUserId) throw new HttpError(400, 'userId query parameter is required');
    const userId = parseId(rawUserId, 'userId');
    if (folder.owner_id === userId) {
      throw new HttpError(400, 'folder owner is always admin');
    }
    const existing = deps.db.getPermission('user', userId, id);
    if (!existing) throw new HttpError(404, 'no permission granted to this user on this folder');
    if (existing.role === 'admin') {
      if (userId === user.id) {
        throw new HttpError(403, 'cannot revoke your own admin permission');
      }
      assertAdminRemains(deps.db, id, userId);
    }

    deps.db.deletePermissionById(existing.id);
    return c.body(null, 204);
  });

  return app;
}

// ---- helpers --------------------------------------------------------------

function assertFolderAdmin(db: Db, userId: number, folderId: number): FolderRow {
  const folder = db.getFolder(folderId);
  if (!folder) throw new HttpError(404, 'folder not found');
  if (!isAdminOn(db, userId, folderId)) {
    throw new HttpError(403, 'admin permission required on this folder');
  }
  return folder;
}

/** Guard: at least one effective admin must remain after an admin-grant removal. */
function assertAdminRemains(db: Db, folderId: number, userId: number): void {
  const admins = folderAdminUserIds(db, folderId);
  if (!admins.some((adminId) => adminId !== userId)) {
    throw new HttpError(403, 'cannot remove the last admin on this folder');
  }
}

function assertNoDuplicateSibling(
  db: Db,
  name: string,
  parentId: number | null,
  excludeFolderId?: number,
): void {
  const existing = db.findFolderByNameAndParent(name, parentId);
  if (existing && existing.id !== excludeFolderId) {
    throw new HttpError(409, 'a folder with this name already exists at this location');
  }
}

function sanitizeFolderName(raw: unknown): string {
  if (typeof raw !== 'string') throw new HttpError(400, 'name is required');
  const name = raw.replace(/[/\\\0]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 255);
  if (!name) throw new HttpError(400, 'folder name must not be empty');
  return name;
}

function isRole(raw: string): raw is Role {
  return raw === 'read' || raw === 'write' || raw === 'admin';
}

function parseId(raw: unknown, label = 'id'): number {
  const value =
    typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
  if (!/^\d+$/.test(value)) throw new HttpError(400, `invalid ${label}`);
  return Number(value);
}

function parseOptionalId(raw: unknown, label: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return parseId(raw, label);
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

interface FolderJson {
  id: string;
  name: string;
  parentId: string | null;
  ownerId: string;
  role: Role;
  createdAt: string;
  children?: FolderJson[];
}

function folderJson(folder: FolderRow, role: Role): Omit<FolderJson, 'children'> {
  return {
    id: String(folder.id),
    name: folder.name,
    parentId: folder.parent_id === null ? null : String(folder.parent_id),
    ownerId: String(folder.owner_id),
    role,
    createdAt: new Date(folder.created_at).toISOString(),
  };
}

function permissionJson(permission: PermissionRow): Record<string, unknown> {
  return {
    id: String(permission.id),
    userId: String(permission.scope_id),
    folderId: String(permission.folder_id),
    role: permission.role,
    createdAt: new Date(permission.created_at).toISOString(),
  };
}
