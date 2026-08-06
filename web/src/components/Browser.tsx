import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, errorMessage, isAbortError, uploadFile } from '../api';
import { cn } from '../cn';
import { useT } from '../i18n';
import { btn, btnSmall, iconBtn, roleBadge, roleBadgeAdmin } from '../ui';
import type { FileItem, FolderNode, Permission, Role, User, UserAdmin } from '../types';
import FileList from './FileList';
import FolderTree from './FolderTree';
import PermissionsPanel from './PermissionsPanel';
import SettingsModal from './SettingsModal';
import UserManagementModal from './UserManagementModal';
import { useToasts } from './Toasts';

interface Props {
  user: User;
  onLogout: () => void | Promise<void>;
}

export default function Browser({ user, onLogout }: Props) {
  const t = useT();
  const toasts = useToasts();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);
  const [users, setUsers] = useState<UserAdmin[]>([]);
  const isGlobalAdmin = user.role === 'admin';
  const [folders, setFolders] = useState<FolderNode[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [files, setFiles] = useState<FileItem[] | null>(null);
  const [permissions, setPermissions] = useState<Permission[] | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<FileItem[] | null>(null);
  const [searching, setSearching] = useState(false);

  const reloadFolders = useCallback(async () => {
    try {
      const res = await api.folders();
      setFolders(res.folders);
    } catch (err) {
      setFolders([]);
      toasts.push('error', errorMessage(err, t('browser.foldersLoadFailed')));
    }
  }, [toasts]);

  useEffect(() => {
    void reloadFolders();
  }, [reloadFolders]);

  // Global user list for admins (used by the user-management modal and to
  // resolve usernames in the permission panel). Best-effort — failure leaves
  // the permission panel on its numeric-id fallback.
  useEffect(() => {
    if (!isGlobalAdmin) {
      setUsers([]);
      return;
    }
    let cancelled = false;
    void api
      .users()
      .then((res) => {
        if (!cancelled) setUsers(res.users);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isGlobalAdmin]);

  const selected = useMemo(
    () => (selectedId === null ? null : findFolder(folders ?? [], selectedId)),
    [folders, selectedId],
  );

  // If the selected folder was deleted (or became invisible), fall back to root.
  useEffect(() => {
    if (selectedId !== null && folders !== null && !selected) setSelectedId(null);
  }, [folders, selectedId, selected]);

  // Subfolders of the currently selected folder (top-level folders at root).
  const subFolders = useMemo(
    () => (selectedId === null ? (folders ?? []) : (selected?.children ?? [])),
    [folders, selectedId, selected],
  );

  // Breadcrumb path from root to the selected folder (always includes root).
  const path = useMemo(() => findPath(folders ?? [], selectedId), [folders, selectedId]);

  // Debounced name search across every folder the user may read.
  // An empty query leaves the browser in its normal folder view.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q === '') {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void api
        .files(null, q)
        .then((res) => {
          if (!cancelled) setSearchResults(res.files);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchQuery]);

  const searchMode = searchQuery.trim() !== '';

  const clearSearch = useCallback(() => setSearchQuery(''), []);

  const handleOpenSearchFolder = useCallback((folderId: string | null) => {
    setSelectedId(folderId);
    setSearchQuery('');
  }, []);

  const selectedRole: Role = selected ? selected.role : user.role === 'admin' ? 'admin' : 'write';
  const isAdmin = selectedRole === 'admin';
  const canWrite = selectedRole === 'write' || isAdmin;

  const reloadFiles = useCallback(
    async (folderId: string | null) => {
      try {
        const res = await api.files(folderId);
        setFiles(res.files);
      } catch (err) {
        setFiles([]);
        if (!(err instanceof ApiError && err.status === 403)) {
          toasts.push('error', errorMessage(err, t('browser.filesLoadFailed')));
        }
      }
    },
    [toasts],
  );

  useEffect(() => {
    void reloadFiles(selectedId);
  }, [selectedId, reloadFiles]);

  const reloadPermissions = useCallback(
    async (folderId: string) => {
      try {
        const res = await api.permissions(folderId);
        setPermissions(res.permissions);
      } catch (err) {
        setPermissions(null);
        if (!(err instanceof ApiError && err.status === 403)) {
          toasts.push('error', errorMessage(err, t('browser.permsLoadFailed')));
        }
      }
    },
    [toasts],
  );

  useEffect(() => {
    setPermissions(null);
    if (selectedId !== null && isAdmin) void reloadPermissions(selectedId);
  }, [selectedId, isAdmin, reloadPermissions]);

  // ---- folder ops ----------------------------------------------------------

  const handleCreateFolder = useCallback(
    async (parentId: string | null, name: string) => {
      try {
        const folder = await api.createFolder(name, parentId);
        await reloadFolders();
        setSelectedId(folder.id);
        toasts.push('success', t('folder.created', { name: folder.name }));
      } catch (err) {
        toasts.push('error', errorMessage(err, t('folder.createFailed')));
      }
    },
    [reloadFolders, toasts],
  );

  const handleRenameFolder = useCallback(
    async (id: string, name: string) => {
      try {
        await api.renameFolder(id, name);
        await reloadFolders();
        toasts.push('success', t('folder.renamed'));
      } catch (err) {
        toasts.push('error', errorMessage(err, t('folder.renameFailed')));
        throw err;
      }
    },
    [reloadFolders, toasts],
  );

  const handleDeleteFolder = useCallback(
    async (id: string) => {
      try {
        await api.deleteFolder(id);
        if (selectedId === id) setSelectedId(null);
        await reloadFolders();
        toasts.push('success', t('folder.deleted'));
      } catch (err) {
        toasts.push('error', errorMessage(err, t('folder.deleteFailed')));
      }
    },
    [selectedId, reloadFolders, toasts],
  );

  // ---- file ops ------------------------------------------------------------

  const handleUpload = useCallback(
    async (file: File, onProgress: (percent: number) => void, signal: AbortSignal) => {
      try {
        const uploaded = await uploadFile(file, selectedId, onProgress, signal);
        toasts.push('success', t('file.uploaded', { name: uploaded.name }));
        await reloadFiles(selectedId);
      } catch (err) {
        if (isAbortError(err)) throw err; // caller handles cancellation silently
        toasts.push('error', errorMessage(err, t('file.uploadFailed')));
        throw err;
      }
    },
    [selectedId, reloadFiles, toasts, t],
  );

  const handleMove = useCallback(
    async (file: FileItem, folderId: string | null) => {
      try {
        await api.moveFile(file.id, folderId);
        await reloadFiles(selectedId);
        toasts.push('success', t('move.done', { name: file.name }));
      } catch (err) {
        toasts.push('error', errorMessage(err, t('move.failed')));
        throw err;
      }
    },
    [selectedId, reloadFiles, toasts, t],
  );

  const handleDeleteFile = useCallback(
    async (file: FileItem) => {
      try {
        await api.deleteFile(file.id);
        await reloadFiles(selectedId);
        toasts.push('success', t('file.deleted', { name: file.name }));
      } catch (err) {
        toasts.push('error', errorMessage(err, t('file.deleteFailed')));
      }
    },
    [selectedId, reloadFiles, toasts],
  );

  // ---- permission ops --------------------------------------------------------

  const handleGrant = useCallback(
    async (userId: string, role: Role) => {
      if (selectedId === null) return;
      try {
        await api.grantPermission(selectedId, userId, role);
        await reloadPermissions(selectedId);
        toasts.push('success', t('perm.granted', { userId, role: t(`role.${role}`) }));
      } catch (err) {
        toasts.push('error', errorMessage(err, t('perm.grantFailed')));
        throw err;
      }
    },
    [selectedId, reloadPermissions, toasts],
  );

  const handleRevoke = useCallback(
    async (userId: string) => {
      if (selectedId === null) return;
      try {
        await api.revokePermission(selectedId, userId);
        await reloadPermissions(selectedId);
        toasts.push('success', t('perm.revoked', { userId }));
      } catch (err) {
        toasts.push('error', errorMessage(err, t('perm.revokeFailed')));
      }
    },
    [selectedId, reloadPermissions, toasts],
  );

  const knownUserIds = useMemo(() => {
    const ids = new Set<string>();
    const visit = (nodes: FolderNode[]) => {
      for (const n of nodes) {
        ids.add(n.ownerId);
        visit(n.children);
      }
    };
    visit(folders ?? []);
    for (const p of permissions ?? []) ids.add(p.userId);
    return [...ids].sort((a, b) => Number(a) - Number(b));
  }, [folders, permissions]);

  // ---- render ---------------------------------------------------------------

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-panel px-3 py-2.5 sm:px-4">
        <div className="min-w-0 truncate text-base font-bold">📁 Telegram Storage</div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="max-w-[10rem] truncate font-semibold" title={`@${user.username}`}>
            {user.displayName || user.username}
          </span>
          <span className={cn(roleBadge, user.role === 'admin' && roleBadgeAdmin)}>{user.role}</span>
          {isGlobalAdmin && (
            <button
              type="button"
              className={`${btn} ${btnSmall}`}
              title={t('users.openTitle')}
              onClick={() => setUsersOpen(true)}
            >
              👥 {t('users.title')}
            </button>
          )}
          <button type="button" className={`${btn} ${btnSmall}`} onClick={() => void onLogout()}>
            {t('common.logout')}
          </button>
          <button
            type="button"
            className={cn(iconBtn, 'text-base opacity-70 hover:opacity-100')}
            title={t('settings.openTitle')}
            onClick={() => setSettingsOpen(true)}
          >
            ⚙️
          </button>
        </div>
      </header>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <UserManagementModal open={usersOpen} onClose={() => setUsersOpen(false)} />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-2 sm:p-3 md:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_auto]">
        <aside className="min-w-0 overflow-auto rounded-lg border border-border bg-panel shadow-card">
          <FolderTree
            nodes={folders ?? []}
            selectedId={selectedId}
            canCreate={canWrite}
            onCreate={handleCreateFolder}
            onRename={handleRenameFolder}
            onDelete={handleDeleteFolder}
            onSelect={setSelectedId}
          />
        </aside>

        <main className="flex min-w-0 flex-col overflow-auto rounded-lg border border-border bg-panel p-2 shadow-card sm:p-3">
          <div className="mb-2.5 flex flex-wrap items-center gap-2 border-b border-border pb-2.5">
            <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5" aria-label={t('browser.breadcrumbAria')}>
              {path.map((seg, i) => {
                const isLast = i === path.length - 1;
                // The root crumb is translated at render time so it follows
                // language switches without recomputing the memoized path.
                const label = seg.id === null ? t('common.root') : seg.name;
                return (
                  <span key={seg.id ?? 'root'} className="inline-flex items-center gap-0.5">
                    {i > 0 && <span className="text-muted">/</span>}
                    {isLast ? (
                      <span className="truncate font-bold" title={label}>
                        {label}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="rounded-md border-0 bg-transparent px-[5px] py-0.5 text-[13px] text-accent hover:bg-info-bg hover:underline"
                        onClick={() => setSelectedId(seg.id)}
                        title={t('browser.gotoFolder', { name: label })}
                      >
                        {label}
                      </button>
                    )}
                  </span>
                );
              })}
            </nav>
            <span className={cn(roleBadge, selectedRole === 'admin' && roleBadgeAdmin)}>
              {t(`role.${selectedRole}`)}
            </span>
          </div>
          <div className="mb-2.5 flex items-center gap-1.5">
            <input
              type="search"
              className="max-w-[340px] flex-1 rounded-lg border border-border bg-white px-2.5 py-1.5 focus:border-accent focus:outline-none"
              placeholder={t('search.placeholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label={t('search.placeholder')}
            />
            {searchQuery !== '' && (
              <button type="button" className={iconBtn} title={t('search.clear')} onClick={clearSearch}>
                ✕
              </button>
            )}
            {searching && <span className="text-xs text-muted">{t('common.loading')}</span>}
          </div>
          <FileList
            files={files}
            subFolders={subFolders}
            searchMode={searchMode}
            searching={searching}
            searchResults={searchResults}
            onOpenFolder={setSelectedId}
            onOpenSearchFolder={handleOpenSearchFolder}
            canWrite={canWrite}
            folders={folders ?? []}
            onUpload={handleUpload}
            onDelete={handleDeleteFile}
            onMove={handleMove}
          />
        </main>

        {selectedId !== null && isAdmin && selected && (
          <PermissionsPanel
            folderName={selected.name}
            ownerId={selected.ownerId}
            permissions={permissions}
            knownUserIds={knownUserIds}
            users={users}
            onGrant={handleGrant}
            onRevoke={handleRevoke}
            onRetry={() => void reloadPermissions(selectedId)}
          />
        )}
      </div>
    </div>
  );
}

function findFolder(nodes: FolderNode[], id: string): FolderNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findFolder(node.children, id);
    if (found) return found;
  }
  return null;
}

function findPath(
  nodes: FolderNode[],
  id: string | null,
): { id: string | null; name: string }[] {
  // Path from root to the selected node; always starts with the root crumb.
  // The root crumb's name is a placeholder — the render translates it via t().
  const trail: { id: string | null; name: string }[] = [{ id: null, name: '' }];
  const walk = (list: FolderNode[]): boolean => {
    for (const n of list) {
      trail.push({ id: n.id, name: n.name });
      if (n.id === id) return true;
      if (walk(n.children)) return true;
      trail.pop();
    }
    return false;
  };
  if (id !== null) walk(nodes);
  return trail;
}
