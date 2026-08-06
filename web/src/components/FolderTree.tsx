import { useState, type KeyboardEvent } from 'react';
import { ROLE_LABEL, ROLE_RANK, type FolderNode } from '../types';

interface Props {
  nodes: FolderNode[];
  selectedId: string | null;
  /** Effective role of the currently selected folder (null = root → write). */
  canCreate: boolean;
  onCreate: (parentId: string | null, name: string) => void | Promise<void>;
  onRename: (id: string, name: string) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onSelect: (id: string | null) => void;
}

export default function FolderTree({
  nodes,
  selectedId,
  canCreate,
  onCreate,
  onRename,
  onDelete,
  onSelect,
}: Props) {
  // createParent: undefined = form closed; null = root; string = folder id
  const [createParent, setCreateParent] = useState<string | null | undefined>(undefined);
  const [createName, setCreateName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [busy, setBusy] = useState(false);

  const openCreate = (parentId: string | null) => {
    setCreateParent(parentId);
    setCreateName('');
  };

  const submitCreate = async () => {
    const name = createName.trim();
    if (!name || createParent === undefined) return;
    setBusy(true);
    try {
      await onCreate(createParent, name);
      setCreateParent(undefined);
      setCreateName('');
    } finally {
      setBusy(false);
    }
  };

  const startRename = (node: FolderNode) => {
    setEditingId(node.id);
    setEditingName(node.name);
  };

  const submitRename = async (id: string) => {
    const name = editingName.trim();
    if (!name) {
      setEditingId(null);
      return;
    }
    setBusy(true);
    try {
      await onRename(id, name);
      setEditingId(null);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = (node: FolderNode) => {
    if (window.confirm(`"${node.name}" 폴더와 그 안의 모든 하위 폴더/파일을 삭제할까요?`)) {
      void onDelete(node.id);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, action: () => void) => {
    if (e.key === 'Enter') action();
    if (e.key === 'Escape') {
      setCreateParent(undefined);
      setEditingId(null);
    }
  };

  const targetName =
    createParent === undefined ? '' : createParent === null ? '루트' : nodeName(nodes, createParent) ?? '?';

  return (
    <div className="tree-panel">
      <div className="tree-header">
        <span className="tree-title">폴더</span>
        {canCreate && (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => openCreate(selectedId)}
            title="선택한 폴더 아래에 새 폴더 생성"
          >
            + 새 폴더
          </button>
        )}
      </div>

      {createParent !== undefined && (
        <div className="tree-create">
          <div className="tree-create-target">생성 위치: {targetName}</div>
          <input
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => onKeyDown(e, submitCreate)}
            placeholder="폴더 이름"
            autoFocus
            maxLength={255}
          />
          <div className="row-actions">
            <button type="button" className="btn btn-small btn-primary" onClick={submitCreate} disabled={busy || !createName.trim()}>
              만들기
            </button>
            <button type="button" className="btn btn-small" onClick={() => setCreateParent(undefined)}>
              취소
            </button>
          </div>
        </div>
      )}

      <div className="tree-list">
        <div
          className={`tree-row ${selectedId === null ? 'selected' : ''}`}
          style={{ paddingLeft: 8 }}
        >
          <span className="tree-name" onClick={() => onSelect(null)}>
            🗂 루트
          </span>
          <span className="role-badge">쓰기</span>
        </div>
        {nodes.length === 0 && <div className="tree-empty">폴더가 없습니다</div>}
        {nodes.map((node) => renderNode(node, 0))}
      </div>
    </div>
  );

  function renderNode(node: FolderNode, depth: number) {
    const editing = editingId === node.id;
    const rank = ROLE_RANK[node.role];
    const canWrite = rank >= ROLE_RANK.write;
    const isAdmin = rank >= ROLE_RANK.admin;

    return (
      <div key={node.id}>
        <div
          className={`tree-row ${selectedId === node.id ? 'selected' : ''}`}
          style={{ paddingLeft: 8 + (depth + 1) * 16 }}
        >
          {editing ? (
            <>
              <input
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onKeyDown={(e) => onKeyDown(e, () => submitRename(node.id))}
                autoFocus
                maxLength={255}
                className="tree-rename-input"
              />
              <button type="button" className="btn btn-small btn-primary" onClick={() => submitRename(node.id)} disabled={busy}>
                저장
              </button>
              <button type="button" className="btn btn-small" onClick={() => setEditingId(null)}>
                취소
              </button>
            </>
          ) : (
            <>
              <span className="tree-name" onClick={() => onSelect(node.id)} title={node.name}>
                📁 {node.name}
              </span>
              <span className="role-badge" title={`권한: ${ROLE_LABEL[node.role]}`}>
                {node.role}
              </span>
              {canWrite && (
                <button type="button" className="icon-btn" title="하위 폴더 생성" onClick={() => openCreate(node.id)}>
                  ＋
                </button>
              )}
              {canWrite && (
                <button type="button" className="icon-btn" title="이름 변경" onClick={() => startRename(node)}>
                  ✏️
                </button>
              )}
              {isAdmin && (
                <button type="button" className="icon-btn danger" title="삭제" onClick={() => confirmDelete(node)}>
                  🗑
                </button>
              )}
            </>
          )}
        </div>
        {node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }
}

function nodeName(nodes: FolderNode[], id: string): string | null {
  for (const n of nodes) {
    if (n.id === id) return n.name;
    const found = nodeName(n.children, id);
    if (found !== null) return found;
  }
  return null;
}
