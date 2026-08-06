import Database from 'better-sqlite3';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  filesTable,
  foldersTable,
  partsTable,
  permissionsTable,
  usersTable,
} from './db/schema.ts';

export interface FileRow {
  id: number;
  name: string;
  size: number;
  mime: string;
  folder_id: number | null;
  owner_id: number | null;
  /** Full-file sha256 (upload-time), used as the download-cache key. null for legacy rows. */
  sha256: string | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PartRow {
  id: number;
  file_id: number;
  part_index: number;
  offset: number;
  part_size: number;
  tg_message_id: number;
  tg_chat_id: string;
  tg_file_id: string;
  checksum: string;
}

export type UserRole = 'admin' | 'member';

export interface UserRow {
  id: number;
  telegram_id: string | null;
  username: string;
  display_name: string | null;
  role: UserRole;
  /** Bumped on logout; sessions signed with an older version are rejected. */
  sess_version: number;
  created_at: number;
}

export interface FolderRow {
  id: number;
  name: string;
  parent_id: number | null;
  owner_id: number;
  created_at: number;
}

export interface PermissionRow {
  id: number;
  scope: 'user' | 'group';
  scope_id: number;
  folder_id: number;
  role: 'read' | 'write' | 'admin';
  created_at: number;
}

export interface NewFile {
  name: string;
  size: number;
  mime: string;
  /** Full-file sha256 (upload-time), stored for the download cache. */
  sha256: string;
}

export interface NewPart {
  partIndex: number;
  offset: number;
  partSize: number;
  tgMessageId: number;
  tgChatId: string;
  tgFileId: string;
  checksum: string;
}

/**
 * Migrations run in order, tracked via `PRAGMA user_version`.
 * v1 = files + parts. v2 = users / folders / permissions (M3).
 * All v2 DDL uses IF NOT EXISTS so it applies cleanly to existing dev DBs.
 *
 * Runtime table creation stays here (raw SQL) so existing databases keep
 * working and late-added columns (users.sess_version, files.sha256) are
 * handled. The Drizzle schema in `src/db/schema.ts` is the source for
 * drizzle-kit migrations (fresh sqlite / Cloudflare D1 targets).
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    folder_id INTEGER,
    owner_id INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    part_index INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    part_size INTEGER NOT NULL,
    tg_message_id INTEGER NOT NULL,
    tg_chat_id TEXT NOT NULL,
    tg_file_id TEXT NOT NULL,
    checksum TEXT NOT NULL,
    UNIQUE (file_id, part_index)
  );

  CREATE INDEX idx_parts_file_id_part_index ON parts (file_id, part_index);
  `,
  `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT UNIQUE,
    username TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  -- scope: 'user' | 'group' — 'group' is defined in the schema but not used in v1.
  CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('user', 'group')),
    scope_id INTEGER NOT NULL,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('read', 'write', 'admin')),
    created_at INTEGER NOT NULL,
    UNIQUE (scope, scope_id, folder_id)
  );

  CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users (telegram_id);
  CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
  CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders (parent_id);
  CREATE INDEX IF NOT EXISTS idx_permissions_folder_id ON permissions (folder_id);
  `,
];

/**
 * SQLite-backed storage. The public surface is **async** (Promise-returning)
 * so the same AppDeps shape can be satisfied by a Cloudflare D1 implementation
 * later; internally it uses the Drizzle ORM over better-sqlite3 (synchronous
 * under the hood for the Node/Docker runtime).
 */
export class Db {
  private readonly raw: Database.Database;
  private readonly db: BetterSQLite3Database<Record<string, never>>;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.db = drizzle(this.raw);
    this.migrate();
  }

  private migrate(): void {
    const client = this.raw;
    const current = client.pragma('user_version', { simple: true }) as number;
    for (let version = current; version < MIGRATIONS.length; version++) {
      const migration = MIGRATIONS[version]!;
      client.transaction(() => {
        client.exec(migration);
        client.pragma(`user_version = ${version + 1}`);
      })();
    }
    this.ensureColumn(client, 'users', 'sess_version', 'sess_version INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn(client, 'files', 'sha256', 'sha256 TEXT');
  }

  private ensureColumn(
    client: Database.Database,
    table: string,
    column: string,
    ddl: string,
  ): void {
    const columns = client.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) {
      client.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  close(): void {
    this.raw.close();
  }

  /**
   * Atomically commits the files row plus all parts rows. Called only after
   * every chunk has been successfully stored in Telegram, so a failed upload
   * never leaves partial rows behind ("parts rollback").
   */
  async insertFileWithParts(
    file: NewFile,
    parts: NewPart[],
    now: number,
    folderId: number | null,
    ownerId: number | null,
  ): Promise<number> {
    return this.db.transaction((tx) => {
      const info = tx
        .insert(filesTable)
        .values({
          name: file.name,
          size: file.size,
          mime: file.mime,
          sha256: file.sha256,
          folder_id: folderId,
          owner_id: ownerId,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        })
        .run();
      const fileId = Number(info.lastInsertRowid);
      for (const part of parts) {
        tx.insert(partsTable)
          .values({
            file_id: fileId,
            part_index: part.partIndex,
            offset: part.offset,
            part_size: part.partSize,
            tg_message_id: part.tgMessageId,
            tg_chat_id: part.tgChatId,
            tg_file_id: part.tgFileId,
            checksum: part.checksum,
          })
          .run();
      }
      return fileId;
    });
  }

  async getFile(id: number): Promise<FileRow | undefined> {
    return this.db.select().from(filesTable).where(eq(filesTable.id, id)).get() as
      | FileRow
      | undefined;
  }

  /** Active files at the root level (folder_id IS NULL). */
  async listRootFiles(): Promise<FileRow[]> {
    return this.db
      .select()
      .from(filesTable)
      .where(and(isNull(filesTable.deleted_at), isNull(filesTable.folder_id)))
      .orderBy(desc(filesTable.created_at), desc(filesTable.id))
      .all() as FileRow[];
  }

  async listFilesInFolder(folderId: number): Promise<FileRow[]> {
    return this.db
      .select()
      .from(filesTable)
      .where(and(isNull(filesTable.deleted_at), eq(filesTable.folder_id, folderId)))
      .orderBy(desc(filesTable.created_at), desc(filesTable.id))
      .all() as FileRow[];
  }

  async listActiveFiles(): Promise<FileRow[]> {
    return this.db
      .select()
      .from(filesTable)
      .where(isNull(filesTable.deleted_at))
      .orderBy(desc(filesTable.created_at), desc(filesTable.id))
      .all() as FileRow[];
  }

  /**
   * Case-insensitive name substring search over active (non-deleted) files.
   * The LIKE pattern is escaped so user input (%, _, \) is treated literally,
   * and the ESCAPE clause is kept to match the original semantics.
   * Permission filtering happens in the route layer.
   */
  async searchFiles(query: string): Promise<FileRow[]> {
    const escaped = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    return this.db
      .select()
      .from(filesTable)
      .where(
        and(
          isNull(filesTable.deleted_at),
          sql`${filesTable.name} LIKE ${`%${escaped}%`} ESCAPE '\\'`,
        ),
      )
      .orderBy(desc(filesTable.created_at), desc(filesTable.id))
      .all() as FileRow[];
  }

  /** Moves an active file to another folder (or root when folderId is null). */
  async updateFileFolder(id: number, folderId: number | null, now: number): Promise<boolean> {
    return (
      this.db
        .update(filesTable)
        .set({ folder_id: folderId, updated_at: now })
        .where(and(eq(filesTable.id, id), isNull(filesTable.deleted_at)))
        .run().changes > 0
    );
  }

  async getPartsForFile(fileId: number): Promise<PartRow[]> {
    return this.db
      .select()
      .from(partsTable)
      .where(eq(partsTable.file_id, fileId))
      .orderBy(partsTable.part_index)
      .all() as PartRow[];
  }

  /** Logical delete — the row survives with deleted_at set. */
  async markDeleted(id: number, now: number): Promise<boolean> {
    return (
      this.db
        .update(filesTable)
        .set({ deleted_at: now, updated_at: now })
        .where(and(eq(filesTable.id, id), isNull(filesTable.deleted_at)))
        .run().changes > 0
    );
  }

  async countParts(): Promise<number> {
    const row = this.db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM parts`);
    return row?.n ?? 0;
  }

  // ---- users ---------------------------------------------------------------

  /**
   * Finds an existing user by telegram_id (when present) or username, or
   * creates one. The very first user ever created becomes the global admin
   * (bootstrap). Dev users have telegram_id = NULL and are matched by username.
   */
  async findOrCreateUser(
    telegramId: string | null,
    username: string,
    displayName: string | null,
    now: number,
  ): Promise<UserRow> {
    const byTelegram =
      telegramId !== null
        ? (this.db.select().from(usersTable).where(eq(usersTable.telegram_id, telegramId)).get() as
            | UserRow
            | undefined)
        : undefined;
    const existing =
      byTelegram ??
      (this.db.select().from(usersTable).where(eq(usersTable.username, username)).get() as
        | UserRow
        | undefined);
    if (existing) return existing;
    return this.db.transaction((tx) => {
      const countRow = tx.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM users`);
      const role: UserRole = (countRow?.n ?? 0) === 0 ? 'admin' : 'member';
      const info = tx
        .insert(usersTable)
        .values({
          telegram_id: telegramId,
          username,
          display_name: displayName,
          role,
          sess_version: 0,
          created_at: now,
        })
        .run();
      return tx.select().from(usersTable).where(eq(usersTable.id, Number(info.lastInsertRowid))).get() as UserRow;
    });
  }

  async getUserById(id: number): Promise<UserRow | undefined> {
    return this.db.select().from(usersTable).where(eq(usersTable.id, id)).get() as
      | UserRow
      | undefined;
  }

  async listUsers(): Promise<UserRow[]> {
    return this.db.select().from(usersTable).orderBy(usersTable.id).all() as UserRow[];
  }

  /** Updates a user's global role ('admin' | 'member'). Returns true if a row changed. */
  async updateUserRole(id: number, role: UserRole): Promise<boolean> {
    return this.db.update(usersTable).set({ role }).where(eq(usersTable.id, id)).run().changes > 0;
  }

  /** Invalidates every existing session of a user (called on logout). */
  async bumpSessionVersion(userId: number): Promise<void> {
    this.db
      .update(usersTable)
      .set({ sess_version: sql`${usersTable.sess_version} + 1` })
      .where(eq(usersTable.id, userId))
      .run();
  }

  // ---- stats ---------------------------------------------------------------

  async countUsers(): Promise<number> {
    const row = this.db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM users`);
    return row?.n ?? 0;
  }

  async countFolders(): Promise<number> {
    const row = this.db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM folders`);
    return row?.n ?? 0;
  }

  async countActiveFiles(): Promise<number> {
    const row = this.db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM files WHERE deleted_at IS NULL`);
    return row?.n ?? 0;
  }

  /** Active-file size/count grouped by containing folder (root = folder_id NULL). */
  async statsByFolder(): Promise<
    Array<{ folder_id: number | null; size: number; file_count: number }>
  > {
    return this.db.all(sql`SELECT folder_id, COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS size FROM files WHERE deleted_at IS NULL GROUP BY folder_id`) as Array<{
      folder_id: number | null;
      size: number;
      file_count: number;
    }>;
  }

  // ---- folders -------------------------------------------------------------

  async createFolder(name: string, parentId: number | null, ownerId: number, now: number): Promise<number> {
    const info = this.db
      .insert(foldersTable)
      .values({ name, parent_id: parentId, owner_id: ownerId, created_at: now })
      .run();
    return Number(info.lastInsertRowid);
  }

  async getFolder(id: number): Promise<FolderRow | undefined> {
    return this.db.select().from(foldersTable).where(eq(foldersTable.id, id)).get() as
      | FolderRow
      | undefined;
  }

  async listFolders(): Promise<FolderRow[]> {
    return this.db.select().from(foldersTable).orderBy(foldersTable.id).all() as FolderRow[];
  }

  async findFolderByNameAndParent(name: string, parentId: number | null): Promise<FolderRow | undefined> {
    return this.db
      .select()
      .from(foldersTable)
      .where(
        and(eq(foldersTable.name, name), parentId === null ? isNull(foldersTable.parent_id) : eq(foldersTable.parent_id, parentId)),
      )
      .get() as FolderRow | undefined;
  }

  async updateFolder(id: number, changes: { name?: string; parentId?: number | null }): Promise<void> {
    const set: { name?: string; parent_id?: number | null } = {};
    if (changes.name !== undefined) set.name = changes.name;
    if (changes.parentId !== undefined) set.parent_id = changes.parentId;
    if (Object.keys(set).length === 0) return;
    this.db.update(foldersTable).set(set).where(eq(foldersTable.id, id)).run();
  }

  /** Depth-first ids of the folder and all of its descendants. */
  async folderSubtreeIds(rootId: number): Promise<number[]> {
    const ids: number[] = [];
    const all = this.db.select().from(foldersTable).all() as FolderRow[];
    const childrenByParent = new Map<number, number[]>();
    for (const f of all) {
      if (f.parent_id === null) continue;
      const list = childrenByParent.get(f.parent_id) ?? [];
      list.push(f.id);
      childrenByParent.set(f.parent_id, list);
    }
    const queue: number[] = [rootId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      ids.push(current);
      for (const child of childrenByParent.get(current) ?? []) queue.push(child);
    }
    return ids;
  }

  /**
   * Deletes a folder and (via FK cascade) its children and permission rows.
   * Files in the whole subtree are logically deleted first (files.folder_id
   * has no FK, so they must be cleaned up explicitly).
   */
  async deleteFolderSubtree(folderId: number, subtreeIds: number[], now: number): Promise<void> {
    this.db.transaction((tx) => {
      this.markFilesDeletedInFolders(tx, subtreeIds, now);
      tx.delete(foldersTable).where(eq(foldersTable.id, folderId)).run();
    });
  }

  private markFilesDeletedInFolders(
    tx: BetterSQLite3Database<Record<string, never>>,
    folderIds: number[],
    now: number,
  ): number {
    if (folderIds.length === 0) return 0;
    const placeholders = sql.join(
      folderIds.map((id) => sql`${id}`),
      sql`, `,
    );
    return tx
      .run(
        sql`UPDATE files SET deleted_at = ${now}, updated_at = ${now} WHERE deleted_at IS NULL AND folder_id IN (${placeholders})`,
      )
      .changes;
  }

  // ---- permissions ---------------------------------------------------------

  async getPermission(
    scope: 'user' | 'group',
    scopeId: number,
    folderId: number,
  ): Promise<PermissionRow | undefined> {
    return this.db
      .select()
      .from(permissionsTable)
      .where(
        and(
          eq(permissionsTable.scope, scope),
          eq(permissionsTable.scope_id, scopeId),
          eq(permissionsTable.folder_id, folderId),
        ),
      )
      .get() as PermissionRow | undefined;
  }

  async listPermissions(folderId: number): Promise<PermissionRow[]> {
    return this.db
      .select()
      .from(permissionsTable)
      .where(eq(permissionsTable.folder_id, folderId))
      .orderBy(permissionsTable.id)
      .all() as PermissionRow[];
  }

  async upsertPermission(
    scope: 'user' | 'group',
    scopeId: number,
    folderId: number,
    role: 'read' | 'write' | 'admin',
    now: number,
  ): Promise<PermissionRow> {
    this.db.run(
      sql`INSERT INTO permissions (scope, scope_id, folder_id, role, created_at)
           VALUES (${scope}, ${scopeId}, ${folderId}, ${role}, ${now})
           ON CONFLICT (scope, scope_id, folder_id)
           DO UPDATE SET role = excluded.role, created_at = excluded.created_at`,
    );
    return this.db
      .select()
      .from(permissionsTable)
      .where(
        and(
          eq(permissionsTable.scope, scope),
          eq(permissionsTable.scope_id, scopeId),
          eq(permissionsTable.folder_id, folderId),
        ),
      )
      .get() as PermissionRow;
  }

  async deletePermissionById(id: number): Promise<boolean> {
    return this.db.delete(permissionsTable).where(eq(permissionsTable.id, id)).run().changes > 0;
  }

  // ---- test-only helpers (corruption / reordering) -------------------------

  async corruptChecksum(fileId: number, partIndex: number): Promise<void> {
    this.db
      .update(partsTable)
      .set({ checksum: 'deadbeef' + '0'.repeat(56) })
      .where(and(eq(partsTable.file_id, fileId), eq(partsTable.part_index, partIndex)))
      .run();
  }

  async swapPartIndices(fileId: number, a: number, b: number): Promise<void> {
    const parts = await this.getPartsForFile(fileId);
    const pa = parts.find((p) => p.part_index === a);
    const pb = parts.find((p) => p.part_index === b);
    if (!pa || !pb) throw new Error(`cannot swap part indices ${a}/${b} of file ${fileId}`);
    this.db.transaction((tx) => {
      tx.update(partsTable).set({ part_index: -1 }).where(eq(partsTable.id, pa.id)).run();
      tx.update(partsTable).set({ part_index: a }).where(eq(partsTable.id, pb.id)).run();
      tx.update(partsTable).set({ part_index: b }).where(eq(partsTable.id, pa.id)).run();
    });
  }
}