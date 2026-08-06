import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../app.ts';
import { requireAuth } from '../auth/middleware.ts';
import { rankOf, resolveFolderRole } from '../auth/permissions.ts';

/**
 * GET /api/stats — storage usage overview (any authenticated user).
 *
 * Global totals (totalSize / fileCount / folderCount / userCount) are visible
 * to every member; folderUsage is filtered to folders the caller may read
 * (global admins and folder owners see everything by construction).
 */
export function statsRoutes(deps: AppDeps, sessionSecret: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(sessionSecret, deps.db));

  app.get('/', (c) => {
    const user = c.get('user');
    const byFolder = deps.db.statsByFolder();

    const folderUsage = byFolder
      .map((row) => {
        if (row.folder_id !== null) {
          const folder = deps.db.getFolder(row.folder_id);
          if (!folder) return null; // orphaned folder_id (should not happen)
          if (rankOf(resolveFolderRole(deps.db, user.id, row.folder_id)) < rankOf('read')) {
            return null;
          }
          return {
            folderId: String(row.folder_id),
            name: folder.name,
            size: row.size,
            fileCount: row.file_count,
          };
        }
        // Root usage is visible to everyone (all members read the root).
        return { folderId: null, name: '(root)', size: row.size, fileCount: row.file_count };
      })
      .filter((entry): entry is FolderUsageJson => entry !== null);

    const totalSize = byFolder.reduce((sum, row) => sum + row.size, 0);
    return c.json({
      totalSize,
      fileCount: deps.db.countActiveFiles(),
      folderCount: deps.db.countFolders(),
      userCount: deps.db.countUsers(),
      folderUsage,
    });
  });

  return app;
}

interface FolderUsageJson {
  folderId: string | null;
  name: string;
  size: number;
  fileCount: number;
}
