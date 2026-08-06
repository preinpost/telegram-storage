import type { AuthConfig, FileItem, FolderNode, Permission, Role, User } from './types';

/** Error thrown for any non-2xx API response; message is the backend {error}. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let unauthorizedHandler: (() => void) | null = null;

/**
 * Registered by the app root: whenever any API call returns 401 (expired /
 * missing session), the app switches back to the login screen.
 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

function notifyUnauthorized(): void {
  unauthorizedHandler?.();
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: 'include', ...init });
  if (res.status === 401) notifyUnauthorized();
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error) message = body.error;
    } catch {
      // non-JSON error body — keep the HTTP status message
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  config: () => request<AuthConfig>('/api/auth/config'),

  me: () => request<{ user: User }>('/api/auth/me'),

  devLogin: (username: string, displayName?: string) =>
    request<{ user: User }>('/api/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(displayName ? { username, displayName } : { username }),
    }),

  /** POST /api/auth/telegram with the Login Widget fields (incl. hash). */
  telegramLogin: (fields: Record<string, string>) =>
    request<{ user: User }>('/api/auth/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }),

  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),

  folders: () => request<{ folders: FolderNode[] }>('/api/folders'),

  createFolder: (name: string, parentId: string | null) =>
    request<FolderNode>('/api/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parentId === null ? { name } : { name, parentId }),
    }),

  renameFolder: (id: string, name: string) =>
    request<FolderNode>(`/api/folders/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  deleteFolder: (id: string) => request<void>(`/api/folders/${id}`, { method: 'DELETE' }),

  files: (folderId: string | null) =>
    request<{ files: FileItem[] }>(
      folderId === null ? '/api/files' : `/api/files?folder_id=${encodeURIComponent(folderId)}`,
    ),

  deleteFile: (id: string) => request<void>(`/api/files/${id}`, { method: 'DELETE' }),

  permissions: (folderId: string) =>
    request<{ permissions: Permission[] }>(`/api/folders/${folderId}/permissions`),

  grantPermission: (folderId: string, userId: string, role: Role) =>
    request<{ permission: Permission }>(`/api/folders/${folderId}/permissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, role }),
    }),

  revokePermission: (folderId: string, userId: string) =>
    request<void>(`/api/folders/${folderId}/permissions?userId=${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    }),
};

/**
 * Multipart upload with progress. XHR (not fetch) because fetch has no upload
 * progress events. The httpOnly session cookie is sent via withCredentials.
 */
export function uploadFile(
  file: File,
  folderId: string | null,
  onProgress: (percent: number) => void,
): Promise<FileItem> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    if (folderId !== null) fd.append('folder_id', folderId);
    fd.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status === 401) notifyUnauthorized();
      let body: { error?: unknown } = {};
      try {
        body = JSON.parse(xhr.responseText) as { error?: unknown };
      } catch {
        // non-JSON body
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText ? (JSON.parse(xhr.responseText) as FileItem) : ({} as FileItem));
      } else {
        const message =
          typeof body.error === 'string' && body.error ? body.error : `HTTP ${xhr.status}`;
        reject(new ApiError(xhr.status, message));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, '네트워크 오류로 업로드하지 못했습니다'));
    xhr.send(fd);
  });
}
