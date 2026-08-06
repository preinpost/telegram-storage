import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

export class Db {
  private readonly db: Database.Database;
  private readonly stmtInsertFile: Database.Statement;
  private readonly stmtInsertPart: Database.Statement;
  private readonly stmtCountActiveFiles: Database.Statement;
  private readonly stmtCountFolders: Database.Statement;
  private readonly stmtSearchFiles: Database.Statement;
  private readonly stmtUpdateFileFolder: Database.Statement;
  private readonly stmtBumpSessionVersion: Database.Statement;
  private readonly stmtStatsByFolder: Database.Statement;
  private readonly stmtGetFile: Database.Statement;
  private readonly stmtListRootFiles: Database.Statement;
  private readonly stmtListFilesInFolder: Database.Statement;
  private readonly stmtListActiveFiles: Database.Statement;
  private readonly stmtGetParts: Database.Statement;
  private readonly stmtMarkDeleted: Database.Statement;
  private readonly stmtCountParts: Database.Statement;
  private readonly stmtGetUserById: Database.Statement;
  private readonly stmtGetUserByTelegramId: Database.Statement;
  private readonly stmtGetUserByUsername: Database.Statement;
  private readonly stmtCreateUser: Database.Statement;
  private readonly stmtCountUsers: Database.Statement;
  private readonly stmtListUsers: Database.Statement;
  private readonly stmtGetFolder: Database.Statement;
  private readonly stmtListFolders: Database.Statement;
  private readonly stmtFindFolderByNameAndParent: Database.Statement;
  private readonly stmtCreateFolder: Database.Statement;
  private readonly stmtGetPermission: Database.Statement;
  private readonly stmtListPermissions: Database.Statement;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();

    this.stmtInsertFile = this.db.prepare(
      'INSERT INTO files (name, size, mime, sha256, folder_id, owner_id, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
    );
    this.stmtInsertPart = this.db.prepare(
      'INSERT INTO parts (file_id, part_index, offset, part_size, tg_message_id, tg_chat_id, tg_file_id, checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.stmtGetFile = this.db.prepare('SELECT * FROM files WHERE id = ?');
    this.stmtListRootFiles = this.db.prepare(
      'SELECT * FROM files WHERE deleted_at IS NULL AND folder_id IS NULL ORDER BY created_at DESC, id DESC',
    );
    this.stmtListFilesInFolder = this.db.prepare(
      'SELECT * FROM files WHERE deleted_at IS NULL AND folder_id = ? ORDER BY created_at DESC, id DESC',
    );
    this.stmtListActiveFiles = this.db.prepare(
      'SELECT * FROM files WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC',
    );
    this.stmtGetParts = this.db.prepare(
      'SELECT * FROM parts WHERE file_id = ? ORDER BY part_index ASC',
    );
    this.stmtMarkDeleted = this.db.prepare(
      'UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    );
    this.stmtCountParts = this.db.prepare('SELECT COUNT(*) AS n FROM parts');
    this.stmtCountActiveFiles = this.db.prepare(
      'SELECT COUNT(*) AS n FROM files WHERE deleted_at IS NULL',
    );
    this.stmtCountFolders = this.db.prepare('SELECT COUNT(*) AS n FROM folders');
    this.stmtSearchFiles = this.db.prepare(
      "SELECT * FROM files WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY created_at DESC, id DESC",
    );
    this.stmtUpdateFileFolder = this.db.prepare(
      'UPDATE files SET folder_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    );
    this.stmtBumpSessionVersion = this.db.prepare(
      'UPDATE users SET sess_version = sess_version + 1 WHERE id = ?',
    );
    this.stmtStatsByFolder = this.db.prepare(
      'SELECT folder_id, COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS size FROM files WHERE deleted_at IS NULL GROUP BY folder_id',
    );
    this.stmtCountUsers = this.db.prepare('SELECT COUNT(*) AS n FROM users');

    this.stmtGetUserById = this.db.prepare('SELECT * FROM users WHERE id = ?');
    this.stmtGetUserByTelegramId = this.db.prepare('SELECT * FROM users WHERE telegram_id = ?');
    this.stmtGetUserByUsername = this.db.prepare('SELECT * FROM users WHERE username = ?');
    this.stmtCreateUser = this.db.prepare(
      'INSERT INTO users (telegram_id, username, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.stmtCountUsers = this.db.prepare('SELECT COUNT(*) AS n FROM users');
    this.stmtListUsers = this.db.prepare('SELECT * FROM users ORDER BY id ASC');

    this.stmtGetFolder = this.db.prepare('SELECT * FROM folders WHERE id = ?');
    this.stmtListFolders = this.db.prepare('SELECT * FROM folders ORDER BY id ASC');
    this.stmtFindFolderByNameAndParent = this.db.prepare(
      'SELECT * FROM folders WHERE name = ? AND parent_id IS ?',
    );
    this.stmtCreateFolder = this.db.prepare(
      'INSERT INTO folders (name, parent_id, owner_id, created_at) VALUES (?, ?, ?, ?)',
    );

    this.stmtGetPermission = this.db.prepare(
      'SELECT * FROM permissions WHERE scope = ? AND scope_id = ? AND folder_id = ?',
    );
    this.stmtListPermissions = this.db.prepare(
      'SELECT * FROM permissions WHERE folder_id = ? ORDER BY id ASC',
    );
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    for (let version = current; version < MIGRATIONS.length; version++) {
      const sql = MIGRATIONS[version]!;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.pragma(`user_version = ${version + 1}`);
      })();
    }
    // Columns added after their tables were created (users.sess_version from
    // session-revocation, files.sha256 from the download cache). Existing DBs
    // keep their user_version but get the new columns; fresh DBs already have
    // them via CREATE TABLE above, so the ALTER is a no-op.
    this.ensureColumn('users', 'sess_version', 'sess_version INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('files', 'sha256', 'sha256 TEXT');
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const columns = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Atomically commits the files row plus all parts rows. Called only after
   * every chunk has been successfully stored in Telegram, so a failed upload
   * never leaves partial rows behind ("parts rollback").
   */
  insertFileWithParts(
    file: NewFile,
    parts: NewPart[],
    now: number,
    folderId: number | null,
    ownerId: number | null,
  ): number {
    const tx = this.db.transaction(() => {
      const info = this.stmtInsertFile.run(
        file.name,
        file.size,
        file.mime,
        file.sha256,
        folderId,
        ownerId,
        now,
        now,
      );
      const fileId = Number(info.lastInsertRowid);
      for (const part of parts) {
        this.stmtInsertPart.run(
          fileId,
          part.partIndex,
          part.offset,
          part.partSize,
          part.tgMessageId,
          part.tgChatId,
          part.tgFileId,
          part.checksum,
        );
      }
      return fileId;
    });
    return tx();
  }

  getFile(id: number): FileRow | undefined {
    return this.stmtGetFile.get(id) as FileRow | undefined;
  }

  /** Active files at the root level (folder_id IS NULL). */
  listRootFiles(): FileRow[] {
    return this.stmtListRootFiles.all() as FileRow[];
  }

  listFilesInFolder(folderId: number): FileRow[] {
    return this.stmtListFilesInFolder.all(folderId) as FileRow[];
  }

  listActiveFiles(): FileRow[] {
    return this.stmtListActiveFiles.all() as FileRow[];
  }

  /**
   * Case-insensitive name substring search over active (non-deleted) files.
   * The LIKE pattern is escaped so user input (%, _, \) is treated literally.
   * Permission filtering happens in the route layer.
   */
  searchFiles(query: string): FileRow[] {
    const escaped = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    return this.stmtSearchFiles.all(`%${escaped}%`) as FileRow[];
  }

  /** Moves an active file to another folder (or root when folderId is null). */
  updateFileFolder(id: number, folderId: number | null, now: number): boolean {
    return this.stmtUpdateFileFolder.run(folderId, now, id).changes > 0;
  }

  getPartsForFile(fileId: number): PartRow[] {
    return this.stmtGetParts.all(fileId) as PartRow[];
  }

  /** Logical delete — the row survives with deleted_at set. */
  markDeleted(id: number, now: number): boolean {
    return this.stmtMarkDeleted.run(now, now, id).changes > 0;
  }

  countParts(): number {
    return (this.stmtCountParts.get() as { n: number }).n;
  }

  // ---- users ---------------------------------------------------------------

  /**
   * Finds an existing user by telegram_id (when present) or username, or
   * creates one. The very first user ever created becomes the global admin
   * (bootstrap). Dev users have telegram_id = NULL and are matched by username.
   */
  findOrCreateUser(
    telegramId: string | null,
    username: string,
    displayName: string | null,
    now: number,
  ): UserRow {
    const existing = telegramId !== null
      ? ((this.stmtGetUserByTelegramId.get(telegramId) ?? this.stmtGetUserByUsername.get(username)) as UserRow | undefined)
      : (this.stmtGetUserByUsername.get(username) as UserRow | undefined);
    if (existing) return existing;
    const create = this.db.transaction((): UserRow => {
      const count = this.stmtCountUsers.get() as { n: number };
      const role: UserRole = count.n === 0 ? 'admin' : 'member';
      const info = this.stmtCreateUser.run(telegramId, username, displayName, role, now);
      return this.stmtGetUserById.get(Number(info.lastInsertRowid)) as UserRow;
    });
    return create();
  }

  getUserById(id: number): UserRow | undefined {
    return this.stmtGetUserById.get(id) as UserRow | undefined;
  }

  listUsers(): UserRow[] {
    return this.stmtListUsers.all() as UserRow[];
  }

  /** Invalidates every existing session of a user (called on logout). */
  bumpSessionVersion(userId: number): void {
    this.stmtBumpSessionVersion.run(userId);
  }

  // ---- stats ---------------------------------------------------------------

  countUsers(): number {
    return (this.stmtCountUsers.get() as { n: number }).n;
  }

  countFolders(): number {
    return (this.stmtCountFolders.get() as { n: number }).n;
  }

  countActiveFiles(): number {
    return (this.stmtCountActiveFiles.get() as { n: number }).n;
  }

  /** Active-file size/count grouped by containing folder (root = folder_id NULL). */
  statsByFolder(): Array<{ folder_id: number | null; size: number; file_count: number }> {
    return this.stmtStatsByFolder.all() as Array<{
      folder_id: number | null;
      size: number;
      file_count: number;
    }>;
  }

  // ---- folders -------------------------------------------------------------

  createFolder(name: string, parentId: number | null, ownerId: number, now: number): number {
    const info = this.stmtCreateFolder.run(name, parentId, ownerId, now);
    return Number(info.lastInsertRowid);
  }

  getFolder(id: number): FolderRow | undefined {
    return this.stmtGetFolder.get(id) as FolderRow | undefined;
  }

  listFolders(): FolderRow[] {
    return this.stmtListFolders.all() as FolderRow[];
  }

  findFolderByNameAndParent(name: string, parentId: number | null): FolderRow | undefined {
    return this.stmtFindFolderByNameAndParent.get(name, parentId) as FolderRow | undefined;
  }

  updateFolder(id: number, changes: { name?: string; parentId?: number | null }): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (changes.name !== undefined) {
      sets.push('name = ?');
      values.push(changes.name);
    }
    if (changes.parentId !== undefined) {
      sets.push('parent_id = ?');
      values.push(changes.parentId);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /** Depth-first ids of the folder and all of its descendants. */
  folderSubtreeIds(rootId: number): number[] {
    const ids: number[] = [];
    const queue: number[] = [rootId];
    const children = this.db.prepare('SELECT id FROM folders WHERE parent_id = ?');
    while (queue.length > 0) {
      const current = queue.shift()!;
      ids.push(current);
      for (const row of children.all(current) as Array<{ id: number }>) queue.push(row.id);
    }
    return ids;
  }

  /**
   * Deletes a folder and (via FK cascade) its children and permission rows.
   * Files in the whole subtree are logically deleted first (files.folder_id
   * has no FK, so they must be cleaned up explicitly).
   */
  deleteFolderSubtree(folderId: number, subtreeIds: number[], now: number): void {
    this.db.transaction(() => {
      this.markFilesDeletedInFolders(subtreeIds, now);
      this.db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
    })();
  }

  private markFilesDeletedInFolders(folderIds: number[], now: number): number {
    if (folderIds.length === 0) return 0;
    const placeholders = folderIds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `UPDATE files SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL AND folder_id IN (${placeholders})`,
      )
      .run(now, now, ...folderIds).changes;
  }

  // ---- permissions ---------------------------------------------------------

  getPermission(
    scope: 'user' | 'group',
    scopeId: number,
    folderId: number,
  ): PermissionRow | undefined {
    return this.stmtGetPermission.get(scope, scopeId, folderId) as PermissionRow | undefined;
  }

  listPermissions(folderId: number): PermissionRow[] {
    return this.stmtListPermissions.all(folderId) as PermissionRow[];
  }

  upsertPermission(
    scope: 'user' | 'group',
    scopeId: number,
    folderId: number,
    role: 'read' | 'write' | 'admin',
    now: number,
  ): PermissionRow {
    this.db
      .prepare(
        `INSERT INTO permissions (scope, scope_id, folder_id, role, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope, scope_id, folder_id)
         DO UPDATE SET role = excluded.role, created_at = excluded.created_at`,
      )
      .run(scope, scopeId, folderId, role, now);
    return this.stmtGetPermission.get(scope, scopeId, folderId) as PermissionRow;
  }

  deletePermissionById(id: number): boolean {
    return this.db.prepare('DELETE FROM permissions WHERE id = ?').run(id).changes > 0;
  }

  // ---- test-only helpers (corruption / reordering) -------------------------

  corruptChecksum(fileId: number, partIndex: number): void {
    this.db
      .prepare('UPDATE parts SET checksum = ? WHERE file_id = ? AND part_index = ?')
      .run('deadbeef' + '0'.repeat(56), fileId, partIndex);
  }

  swapPartIndices(fileId: number, a: number, b: number): void {
    const parts = this.getPartsForFile(fileId);
    const pa = parts.find((p) => p.part_index === a);
    const pb = parts.find((p) => p.part_index === b);
    if (!pa || !pb) throw new Error(`cannot swap part indices ${a}/${b} of file ${fileId}`);
    const swap = this.db.transaction(() => {
      this.db.prepare('UPDATE parts SET part_index = ? WHERE id = ?').run(-1, pa.id);
      this.db.prepare('UPDATE parts SET part_index = ? WHERE id = ?').run(a, pb.id);
      this.db.prepare('UPDATE parts SET part_index = ? WHERE id = ?').run(b, pa.id);
    });
    swap();
  }
}
