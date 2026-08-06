import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, errorMessage, uploadFile } from '../api';
import { useT } from '../i18n';
import type { FileItem, FolderNode, Permission, Role, User } from '../types';
import FileList from './FileList';
import FolderTree from './FolderTree';
import PermissionsPanel from './PermissionsPanel';
import SettingsModal from './SettingsModal';
import { useToasts } from './Toasts';

interface Props {
  user: User;
  onLogout: () => void | Promise<void>;
}

export default function Browser({ user, onLogout }: Props) {
  const t = useT();
  const toasts = useToasts();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [folders, setFolders] = useState<FolderNode[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [files, setFiles] = useState<FileItem[] | null>(null);
  const [permissions, setPermissions] = useState<Permission[] | null>(null);

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
    async (file: File, onProgress: (percent: number) => void) => {
      try {
        const uploaded = await uploadFile(file, selectedId, onProgress);
        toasts.push('success', t('file.uploaded', { name: uploaded.name }));
        await reloadFiles(selectedId);
      } catch (err) {
        toasts.push('error', errorMessage(err, t('file.uploadFailed')));
        throw err;
      }
    },
    [selectedId, reloadFiles, toasts],
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
    <div className="app">
      <header className="topbar">
        <div className="brand">📁 Telegram Storage</div>
        <div className="user-menu">
          <span className="user-name" title={`@${user.username}`}>
            {user.displayName || user.username}
          </span>
          <span className={`role-badge ${user.role === 'admin' ? 'admin' : ''}`}>{user.role}</span>
          <button type="button" className="btn btn-small" onClick={() => void onLogout()}>
            {t('common.logout')}
          </button>
          <button
            type="button"
            className="icon-btn gear-btn"
            title={t('settings.openTitle')}
            onClick={() => setSettingsOpen(true)}
          >
            ⚙️
          </button>
        </div>
      </header>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <div className="layout">
        <aside className="sidebar">
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

        <main className="main">
          <div className="current-folder">
            <nav className="breadcrumb" aria-label={t('browser.breadcrumbAria')}>
              {path.map((seg, i) => {
                const isLast = i === path.length - 1;
                // The root crumb is translated at render time so it follows
                // language switches without recomputing the memoized path.
                const label = seg.id === null ? t('common.root') : seg.name;
                return (
                  <span key={seg.id ?? 'root'} className="crumb">
                    {i > 0 && <span className="crumb-sep">/</span>}
                    {isLast ? (
                      <span className="crumb-current" title={label}>
                        {label}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="crumb-link"
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
            <span className={`role-badge ${selectedRole === 'admin' ? 'admin' : ''}`}>
              {selectedRole}
            </span>
          </div>
          <FileList
            files={files}
            subFolders={subFolders}
            onOpenFolder={setSelectedId}
            canWrite={canWrite}
            onUpload={handleUpload}
            onDelete={handleDeleteFile}
          />
        </main>

        {selectedId !== null && isAdmin && selected && (
          <PermissionsPanel
            folderName={selected.name}
            ownerId={selected.ownerId}
            permissions={permissions}
            knownUserIds={knownUserIds}
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
