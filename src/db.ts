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

export interface NewFile {
  name: string;
  size: number;
  mime: string;
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
 * v1 = files + parts (users / folders / permissions are out of scope until M3).
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
];

export class Db {
  private readonly db: Database.Database;
  private readonly stmtInsertFile: Database.Statement;
  private readonly stmtInsertPart: Database.Statement;
  private readonly stmtGetFile: Database.Statement;
  private readonly stmtListFiles: Database.Statement;
  private readonly stmtGetParts: Database.Statement;
  private readonly stmtMarkDeleted: Database.Statement;
  private readonly stmtCountParts: Database.Statement;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();

    this.stmtInsertFile = this.db.prepare(
      'INSERT INTO files (name, size, mime, folder_id, owner_id, deleted_at, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)',
    );
    this.stmtInsertPart = this.db.prepare(
      'INSERT INTO parts (file_id, part_index, offset, part_size, tg_message_id, tg_chat_id, tg_file_id, checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.stmtGetFile = this.db.prepare('SELECT * FROM files WHERE id = ?');
    this.stmtListFiles = this.db.prepare(
      'SELECT * FROM files WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC',
    );
    this.stmtGetParts = this.db.prepare(
      'SELECT * FROM parts WHERE file_id = ? ORDER BY part_index ASC',
    );
    this.stmtMarkDeleted = this.db.prepare(
      'UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    );
    this.stmtCountParts = this.db.prepare('SELECT COUNT(*) AS n FROM parts');
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
  }

  close(): void {
    this.db.close();
  }

  /**
   * Atomically commits the files row plus all parts rows. Called only after
   * every chunk has been successfully stored in Telegram, so a failed upload
   * never leaves partial rows behind ("parts rollback").
   */
  insertFileWithParts(file: NewFile, parts: NewPart[], now: number): number {
    const tx = this.db.transaction(() => {
      const info = this.stmtInsertFile.run(file.name, file.size, file.mime, now, now);
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

  listActiveFiles(): FileRow[] {
    return this.stmtListFiles.all() as FileRow[];
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
