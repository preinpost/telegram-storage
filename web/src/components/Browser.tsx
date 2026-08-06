import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, errorMessage, uploadFile } from '../api';
import type { FileItem, FolderNode, Permission, Role, User } from '../types';
import FileList from './FileList';
import FolderTree from './FolderTree';
import PermissionsPanel from './PermissionsPanel';
import { useToasts } from './Toasts';

interface Props {
  user: User;
  onLogout: () => void | Promise<void>;
}

export default function Browser({ user, onLogout }: Props) {
  const toasts = useToasts();
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
      toasts.push('error', errorMessage(err, '폴더 목록을 불러오지 못했습니다'));
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
          toasts.push('error', errorMessage(err, '파일 목록을 불러오지 못했습니다'));
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
          toasts.push('error', errorMessage(err, '권한 목록을 불러오지 못했습니다'));
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
        toasts.push('success', `폴더 "${folder.name}" 생성됨`);
      } catch (err) {
        toasts.push('error', errorMessage(err, '폴더 생성 실패'));
      }
    },
    [reloadFolders, toasts],
  );

  const handleRenameFolder = useCallback(
    async (id: string, name: string) => {
      try {
        await api.renameFolder(id, name);
        await reloadFolders();
        toasts.push('success', '폴더 이름이 변경되었습니다');
      } catch (err) {
        toasts.push('error', errorMessage(err, '폴더 이름 변경 실패'));
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
        toasts.push('success', '폴더가 삭제되었습니다');
      } catch (err) {
        toasts.push('error', errorMessage(err, '폴더 삭제 실패'));
      }
    },
    [selectedId, reloadFolders, toasts],
  );

  // ---- file ops ------------------------------------------------------------

  const handleUpload = useCallback(
    async (file: File, onProgress: (percent: number) => void) => {
      try {
        const uploaded = await uploadFile(file, selectedId, onProgress);
        toasts.push('success', `"${uploaded.name}" 업로드 완료`);
        await reloadFiles(selectedId);
      } catch (err) {
        toasts.push('error', errorMessage(err, '업로드 실패'));
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
        toasts.push('success', `"${file.name}" 삭제됨`);
      } catch (err) {
        toasts.push('error', errorMessage(err, '파일 삭제 실패'));
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
        toasts.push('success', `User #${userId} → ${role} 권한 부여됨`);
      } catch (err) {
        toasts.push('error', errorMessage(err, '권한 부여 실패'));
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
        toasts.push('success', `User #${userId} 권한 회수됨`);
      } catch (err) {
        toasts.push('error', errorMessage(err, '권한 회수 실패'));
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
            로그아웃
          </button>
        </div>
      </header>

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
            <span className="current-label">현재 폴더:</span>
            <span className="current-name">{selected ? selected.name : '루트'}</span>
            {!selected && <span className="role-badge">쓰기</span>}
            {selected && <span className="role-badge">{selected.role}</span>}
          </div>
          <FileList
            files={files}
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
