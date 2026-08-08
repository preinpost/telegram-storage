import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle schema — the single source of truth for the storage layer, mapping
 * 1:1 to the runtime tables created in `src/db.ts`.
 *
 * Field names are the snake_case column names (matching the row interfaces in
 * `src/db.ts`) so the rest of the code reads them unchanged. Keeping both
 * sqlite (better-sqlite3, Node/Docker) and D1 (Cloudflare Workers) in view:
 * the same schema feeds `drizzle-kit` for either target.
 *
 * NOTE: runtime table creation for existing DBs continues to go through the
 * `MIGRATIONS` array in `src/db.ts` (which handles `PRAGMA user_version` and
 * late-added columns). This schema is what drizzle-kit generates migrations
 * from for a fresh deployment / D1.
 */

export const filesTable = sqliteTable(
  'files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    size: integer('size').notNull(),
    mime: text('mime').notNull().default('application/octet-stream'),
    folder_id: integer('folder_id'),
    owner_id: integer('owner_id'),
    deleted_at: integer('deleted_at'),
    /** Full-file sha256 (upload-time), used as the download-cache key. */
    sha256: text('sha256'),
    /** 'uploading' (accepted, parts not persisted yet) → 'ready' | 'failed'. */
    status: text('status', { enum: ['uploading', 'ready', 'failed'] })
      .notNull()
      .default('ready'),
    /** Failure reason when status = 'failed'. */
    error: text('error'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => [index('idx_files_folder_id').on(t.folder_id)],
);

export const partsTable = sqliteTable(
  'parts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    file_id: integer('file_id').notNull().references(() => filesTable.id, { onDelete: 'cascade' }),
    part_index: integer('part_index').notNull(),
    offset: integer('offset').notNull(),
    part_size: integer('part_size').notNull(),
    tg_message_id: integer('tg_message_id').notNull(),
    tg_chat_id: text('tg_chat_id').notNull(),
    tg_file_id: text('tg_file_id').notNull(),
    checksum: text('checksum').notNull(),
  },
  (t) => [uniqueIndex('idx_parts_file_id_part_index').on(t.file_id, t.part_index)],
);

export const usersTable = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    telegram_id: text('telegram_id'),
    username: text('username').notNull(),
    display_name: text('display_name'),
    role: text('role').notNull().default('member').$type<'admin' | 'member'>(),
    /** Bumped on logout; sessions signed with an older version are rejected. */
    sess_version: integer('sess_version').notNull().default(0),
    created_at: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_users_telegram_id').on(t.telegram_id),
    index('idx_users_username').on(t.username),
  ],
);

export const foldersTable = sqliteTable(
  'folders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    // owner_id has no DB-level FK (deletion is managed explicitly by the
    // folder-delete path); parent_id self-reference is omitted here to avoid
    // the circular-schema-inference issue — runtime DDL in src/db.ts keeps the
    // real FK/ON DELETE CASCADE.
    parent_id: integer('parent_id'),
    owner_id: integer('owner_id').notNull().references(() => usersTable.id),
    created_at: integer('created_at').notNull(),
  },
  (t) => [index('idx_folders_parent_id').on(t.parent_id)],
);

export const permissionsTable = sqliteTable(
  'permissions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scope: text('scope').notNull().default('user').$type<'user' | 'group'>(),
    scope_id: integer('scope_id').notNull(),
    folder_id: integer('folder_id').notNull().references(() => foldersTable.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<'read' | 'write' | 'admin'>(),
    created_at: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_permissions_scope_scope_id_folder').on(t.scope, t.scope_id, t.folder_id),
    index('idx_permissions_folder_id').on(t.folder_id),
  ],
);
