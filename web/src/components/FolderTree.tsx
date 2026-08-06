import { useState, type KeyboardEvent } from 'react';
import { cn } from '../cn';
import { useT } from '../i18n';
import { btn, btnPrimary, btnSmall, iconBtn, iconBtnDanger, input, roleBadge } from '../ui';
import { ROLE_RANK, type FolderNode } from '../types';

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
  const t = useT();
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
    if (window.confirm(t('folder.deleteConfirm', { name: node.name }))) {
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
    createParent === undefined ? '' : createParent === null ? t('common.root') : nodeName(nodes, createParent) ?? '?';

  return (
    <div className="min-w-[240px] p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-bold">{t('folder.title')}</span>
        {canCreate && (
          <button
            type="button"
            className={`${btn} ${btnSmall}`}
            onClick={() => openCreate(selectedId)}
            title={t('folder.newTitle')}
          >
            {t('folder.new')}
          </button>
        )}
      </div>

      {createParent !== undefined && (
        <div className="mb-2 flex flex-col gap-1.5 rounded-lg border border-dashed border-border bg-row-alt p-2">
          <div className="text-xs text-muted">{t('folder.createAt', { name: targetName })}</div>
          <input
            className={input}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => onKeyDown(e, submitCreate)}
            placeholder={t('folder.namePlaceholder')}
            autoFocus
            maxLength={255}
          />
          <div className="flex gap-1.5">
            <button type="button" className={`${btn} ${btnSmall} ${btnPrimary}`} onClick={submitCreate} disabled={busy || !createName.trim()}>
              {t('common.create')}
            </button>
            <button type="button" className={`${btn} ${btnSmall}`} onClick={() => setCreateParent(undefined)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col">
        <div
          className={cn('flex cursor-default items-center gap-[5px] rounded-md px-2 py-1 hover:bg-row-hover', selectedId === null && 'bg-info-bg')}
          style={{ paddingLeft: 8 }}
        >
          <span className="flex-1 cursor-pointer truncate" onClick={() => onSelect(null)}>
            🗂 {t('common.root')}
          </span>
          <span className={roleBadge}>{t('role.write')}</span>
        </div>
        {nodes.length === 0 && <div className="p-2 text-xs text-muted">{t('folder.empty')}</div>}
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
          className={cn('flex cursor-default items-center gap-[5px] rounded-md px-2 py-1 hover:bg-row-hover', selectedId === node.id && 'bg-info-bg')}
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
                className="min-w-0 flex-1 rounded-md border border-border bg-white px-1.5 py-[3px] focus:border-accent focus:outline-2 focus:outline-focus-ring"
              />
              <button type="button" className={`${btn} ${btnSmall} ${btnPrimary}`} onClick={() => submitRename(node.id)} disabled={busy}>
                {t('common.save')}
              </button>
              <button type="button" className={`${btn} ${btnSmall}`} onClick={() => setEditingId(null)}>
                {t('common.cancel')}
              </button>
            </>
          ) : (
            <>
              <span className="flex-1 cursor-pointer truncate" onClick={() => onSelect(node.id)} title={node.name}>
                📁 {node.name}
              </span>
              <span className={roleBadge} title={t('folder.roleTitle', { role: t(`role.${node.role}`) })}>
                {node.role}
              </span>
              {canWrite && (
                <button type="button" className={iconBtn} title={t('folder.createChildTitle')} onClick={() => openCreate(node.id)}>
                  ＋
                </button>
              )}
              {canWrite && (
                <button type="button" className={iconBtn} title={t('folder.renameTitle')} onClick={() => startRename(node)}>
                  ✏️
                </button>
              )}
              {isAdmin && (
                <button type="button" className={cn(iconBtn, iconBtnDanger)} title={t('common.delete')} onClick={() => confirmDelete(node)}>
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
