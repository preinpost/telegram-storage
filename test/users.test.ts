import { afterEach, describe, expect, it } from 'vitest';
import { api, devLogin, startHarness } from './helpers.ts';
import type { TestHarness } from './helpers.ts';

const harnesses: TestHarness[] = [];

async function harness(options?: Parameters<typeof startHarness>[0]): Promise<TestHarness> {
  const h = await startHarness(options);
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

interface UserJson {
  id: string;
  username: string;
  displayName: string | null;
  role: 'admin' | 'member';
  telegramId: string | null;
  createdAt: string;
}

async function getUser(h: TestHarness, username: string): Promise<UserJson> {
  const res = await api(h, '/api/users');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { users: UserJson[] };
  const u = body.users.find((x) => x.username === username);
  if (!u) throw new Error(`user "${username}" not found`);
  return u;
}

describe('user management (GET /api/users)', () => {
  it('lists every user for a global admin', async () => {
    const h = await harness();
    await devLogin(h.baseUrl, 'bob');

    const res = await api(h, '/api/users');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: UserJson[] };
    expect(body.users.map((u) => u.username).sort()).toEqual(['admin', 'bob']);

    const bob = body.users.find((u) => u.username === 'bob')!;
    expect(bob.role).toBe('member');
    expect(bob.displayName).toBe('bob');
    expect(bob.telegramId).toBeNull();
    expect(Number.isNaN(Date.parse(bob.createdAt))).toBe(false);
  });

  it('returns 403 for a non-admin member', async () => {
    const h = await harness();
    const bob = await devLogin(h.baseUrl, 'bob');

    const res = await api(h, '/api/users', {}, bob);
    expect(res.status).toBe(403);

    const patch = await api(
      h,
      '/api/users/1',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) },
      bob,
    );
    expect(patch.status).toBe(403);
  });

  it('requires authentication', async () => {
    const h = await harness({ devAuth: false });
    const res = await fetch(`${h.baseUrl}/api/users`);
    expect(res.status).toBe(401);
  });
});

describe('user management (PATCH /api/users/:id)', () => {
  it('promotes a member to admin and back to member', async () => {
    const h = await harness();
    await devLogin(h.baseUrl, 'bob');
    const bob = await getUser(h, 'bob');

    const promote = await api(
      h,
      `/api/users/${bob.id}`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) },
    );
    expect(promote.status).toBe(200);
    expect(((await promote.json()) as { user: UserJson }).user.role).toBe('admin');

    // Now two global admins exist, so demoting bob back is allowed.
    const demote = await api(
      h,
      `/api/users/${bob.id}`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'member' }) },
    );
    expect(demote.status).toBe(200);
    expect(((await demote.json()) as { user: UserJson }).user.role).toBe('member');
  });

  it('guards the last admin from demotion (403)', async () => {
    const h = await harness();
    const admin = await getUser(h, 'admin');

    const res = await api(
      h,
      `/api/users/${admin.id}`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'member' }) },
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 for a missing user and 400 for an invalid role', async () => {
    const h = await harness();

    const notFound = await api(
      h,
      '/api/users/999',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'member' }) },
    );
    expect(notFound.status).toBe(404);

    const badRole = await api(
      h,
      '/api/users/1',
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'owner' }) },
    );
    expect(badRole.status).toBe(400);
  });

  it('treats a no-op role change as a 200 without demoting the last admin', async () => {
    const h = await harness();
    const admin = await getUser(h, 'admin');

    const res = await api(
      h,
      `/api/users/${admin.id}`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: UserJson }).user.role).toBe('admin');
  });
});
