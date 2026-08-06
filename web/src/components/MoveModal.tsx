import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import type { FileItem, FolderNode } from '../types';

interface Props {
  file: FileItem;
  folders: FolderNode[];
  onClose: () => void;
  onMove: (file: FileItem, folderId: string | null) => Promise<void>;
}

interface FlatFolder {
  id: string;
  name: string;
  depth: number;
}

/**
 * Folder picker for moving a file. Renders a flattened, indented folder list
 * (root → leaves) plus a "root" option. The parent passes `key={file.id}` so
 * state resets per file.
 */
export default function MoveModal({ file, folders, onClose, onMove }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<string | null>(file.folderId);

  const flat = useMemo(() => {
    const out: FlatFolder[] = [];
    const walk = (nodes: FolderNode[], depth: number) => {
      for (const n of nodes) {
        out.push({ id: n.id, name: n.name, depth });
        walk(n.children, depth + 1);
      }
    };
    walk(folders, 0);
    return out;
  }, [folders]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await onMove(file, target);
    } catch {
      setError(t('move.failed'));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('move.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{t('move.title')}</h2>
          <button type="button" className="icon-btn" title={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="move-file-name" title={file.name}>
            📄 {file.name}
          </p>
          <span className="settings-label">{t('move.choose')}</span>
          <div className="move-folder-list">
            <button
              type="button"
              className={`move-folder-row ${target === null ? 'active' : ''}`}
              onClick={() => setTarget(null)}
            >
              <span aria-hidden>📂</span>
              {t('common.root')}
            </button>
            {flat.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`move-folder-row ${target === f.id ? 'active' : ''}`}
                style={{ paddingLeft: 10 + f.depth * 18 }}
                onClick={() => setTarget(f.id)}
              >
                <span aria-hidden>📁</span>
                {f.name}
              </button>
            ))}
          </div>
          {error !== '' && <p className="form-error">{error}</p>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={busy}
          >
            {t('move.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
