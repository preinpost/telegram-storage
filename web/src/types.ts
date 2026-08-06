/** Shared API types (mirrors the backend JSON contract — see README API section). */

export type UserRole = 'admin' | 'member';
export type Role = 'read' | 'write' | 'admin';

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
  telegramId: string | null;
  createdAt: string;
}

/** GET /api/auth/config (public). */
export interface AuthConfig {
  devAuth: boolean;
  botUsername: string | null;
}

export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  ownerId: string;
  role: Role;
  createdAt: string;
  children: FolderNode[];
}

export interface FileItem {
  id: string;
  name: string;
  size: number;
  mime: string;
  folderId: string | null;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Permission {
  id: string;
  userId: string;
  folderId: string;
  role: Role;
  createdAt: string;
}

export const ROLE_RANK: Record<Role, number> = { read: 1, write: 2, admin: 3 };

// Human-readable role labels are i18n keys ('role.read' | 'role.write' | 'role.admin')
// — use `t(\`role.${role}\`)` from src/i18n.tsx in components.
