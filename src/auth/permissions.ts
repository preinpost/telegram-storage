import type { Db, UserRow } from '../db.ts';
import { HttpError } from '../errors.ts';

export type Role = 'read' | 'write' | 'admin';

const ROLE_RANK: Record<Role, number> = { read: 1, write: 2, admin: 3 };

export function rankOf(role: string): number {
  return ROLE_RANK[role as Role] ?? 0;
}

/**
 * Effective permission resolution (approved M3 rules):
 *   1. direct permission row for this user on this folder wins
 *   2. otherwise the nearest ancestor folder with a row for this user
 *   3. otherwise the default: members get 'read' (everyone can read)
 * Plus two unconditional overrides: global admins (users.role='admin') and the
 * folder owner are always 'admin'.
 */
export async function resolveFolderRole(
  db: Db,
  userId: number,
  folderId: number,
): Promise<Role> {
  const user = await db.getUserById(userId);
  if (!user) throw new HttpError(401, 'user not found');
  if (user.role === 'admin') return 'admin';
  const folder = await db.getFolder(folderId);
  if (!folder) throw new HttpError(404, 'folder not found');
  if (folder.owner_id === userId) return 'admin';

  let cursor: number | null = folder.id;
  for (let hop = 0; hop < 1000 && cursor !== null; hop++) {
    const permission = await db.getPermission('user', userId, cursor);
    if (permission) return permission.role;
    const current = await db.getFolder(cursor);
    cursor = current?.parent_id ?? null;
  }
  return 'read';
}

/**
 * Effective role for a file. Files at the root (folder_id NULL) follow the
 * root rule: members default to 'write' (anyone may create folders at the
 * root), admins are 'admin'.
 */
export async function resolveFileRole(
  db: Db,
  user: UserRow,
  folderId: number | null,
): Promise<Role> {
  if (folderId === null) return user.role === 'admin' ? 'admin' : 'write';
  return resolveFolderRole(db, user.id, folderId);
}

/** Throws 403 unless the user's effective role on the folder is >= minimum. */
export async function requireRole(
  db: Db,
  userId: number,
  folderId: number,
  minimum: Role,
): Promise<Role> {
  const role = await resolveFolderRole(db, userId, folderId);
  if (rankOf(role) < rankOf(minimum)) {
    throw new HttpError(403, `requires ${minimum} permission on this folder`);
  }
  return role;
}

export async function isAdminOn(db: Db, userId: number, folderId: number): Promise<boolean> {
  return rankOf(await resolveFolderRole(db, userId, folderId)) >= rankOf('admin');
}

/**
 * All user ids that are effectively admins of a folder: the owner, global
 * admins, direct admin grants, and admin grants inherited from ancestors.
 * Used for the "keep at least one admin" guard on permission changes.
 */
export async function folderAdminUserIds(db: Db, folderId: number): Promise<number[]> {
  const admins = new Set<number>();
  const folder = await db.getFolder(folderId);
  if (!folder) return [];
  admins.add(folder.owner_id);
  for (const user of await db.listUsers()) {
    if (user.role === 'admin') admins.add(user.id);
  }
  let cursor: number | null = folder.id;
  for (let hop = 0; hop < 1000 && cursor !== null; hop++) {
    for (const permission of await db.listPermissions(cursor)) {
      if (permission.role === 'admin' && permission.scope === 'user') {
        admins.add(permission.scope_id);
      }
    }
    const current = await db.getFolder(cursor);
    cursor = current?.parent_id ?? null;
  }
  return [...admins];
}
