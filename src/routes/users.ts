import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppDeps, AppEnv } from '../app.ts';
import { requireAuth } from '../auth/middleware.ts';
import type { UserRow } from '../db.ts';
import { HttpError } from '../errors.ts';

/**
 * Global user management (global admin only).
 *
 *   GET   /api/users        list every user
 *   PATCH /api/users/:id    change the global role ('admin' | 'member')
 *
 * Folder-scoped permissions live under /api/folders/:id/permissions — this
 * route only manages the account's global role (member ⇄ admin).
 */
export function usersRoutes(deps: AppDeps, sessionSecret: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(sessionSecret, deps.db));

  app.get('/', (c) => {
    assertGlobalAdmin(c.get('user'));
    return c.json({ users: deps.db.listUsers().map(userJson) });
  });

  app.patch('/:id', async (c) => {
    assertGlobalAdmin(c.get('user'));
    const id = parseId(c.req.param('id'), 'user id');
    const body = await readJson(c);

    const role = body.role;
    if (role !== 'admin' && role !== 'member') {
      throw new HttpError(400, 'role must be admin or member');
    }

    const target = deps.db.getUserById(id);
    if (!target) throw new HttpError(404, 'user not found');

    if (target.role !== role) {
      // Never demote the last remaining global admin.
      if (target.role === 'admin' && role !== 'admin') {
        const adminCount = deps.db.listUsers().filter((u) => u.role === 'admin').length;
        if (adminCount <= 1) {
          throw new HttpError(403, 'cannot demote the last admin');
        }
      }
      deps.db.updateUserRole(id, role);
    }

    const updated = deps.db.getUserById(id) ?? target;
    return c.json({ user: userJson(updated) });
  });

  return app;
}

function assertGlobalAdmin(user: UserRow): UserRow {
  if (user.role !== 'admin') throw new HttpError(403, 'admin role required');
  return user;
}

function userJson(u: UserRow): Record<string, unknown> {
  return {
    id: String(u.id),
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    telegramId: u.telegram_id,
    createdAt: new Date(u.created_at).toISOString(),
  };
}

function parseId(raw: unknown, label = 'id'): number {
  const value =
    typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
  if (!/^\d+$/.test(value)) throw new HttpError(400, `invalid ${label}`);
  return Number(value);
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
