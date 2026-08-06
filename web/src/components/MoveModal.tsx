import { useMemo, useState } from 'react';
import { Dialog } from '@base-ui-components/react/dialog';
import { cn } from '../cn';
import { useT } from '../i18n';
import { btn, btnPrimary, iconBtn } from '../ui';
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
 *
 * Built on Base UI's headless Dialog (ESC / backdrop / focus trap handled by
 * the primitive). Closing is suppressed while a move is in flight.
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
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      disablePointerDismissal={busy}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[900] flex items-center justify-center bg-[rgba(16,24,40,0.45)] p-4 transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-[910] w-full max-w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-modal outline-none transition-all duration-150 data-[starting-style]:translate-y-[calc(-50%+6px)] data-[starting-style]:opacity-0 data-[ending-style]:translate-y-[calc(-50%+6px)] data-[ending-style]:opacity-0">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="m-0 text-lg font-bold">{t('move.title')}</Dialog.Title>
            <Dialog.Close className={iconBtn} title={t('common.close')} disabled={busy}>
              ✕
            </Dialog.Close>
          </div>
          <div className="flex flex-col gap-4">
            <p className="m-0 truncate font-semibold" title={file.name}>
              📄 {file.name}
            </p>
            <div className="flex flex-col gap-2">
              <span className="text-xs text-muted">{t('move.choose')}</span>
              <div className="mt-1.5 max-h-[260px] overflow-y-auto rounded-lg border border-border">
                <button
                  type="button"
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-1.5 border-0 bg-white px-2.5 py-[7px] text-left text-[13px] hover:bg-info-bg',
                    target === null && 'bg-info-bg font-semibold text-accent-dark',
                  )}
                  onClick={() => setTarget(null)}
                >
                  <span aria-hidden>📂</span>
                  {t('common.root')}
                </button>
                {flat.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-1.5 border-0 bg-white px-2.5 py-[7px] text-left text-[13px] hover:bg-info-bg',
                      target === f.id && 'bg-info-bg font-semibold text-accent-dark',
                    )}
                    style={{ paddingLeft: 10 + f.depth * 18 }}
                    onClick={() => setTarget(f.id)}
                  >
                    <span aria-hidden>📁</span>
                    {f.name}
                  </button>
                ))}
              </div>
            </div>
            {error !== '' && <p className="m-0 text-xs text-danger">{error}</p>}
          </div>
          <div className="mt-[18px] flex justify-end gap-2">
            <Dialog.Close className={btn} disabled={busy}>
              {t('common.cancel')}
            </Dialog.Close>
            <button
              type="button"
              className={`${btn} ${btnPrimary}`}
              onClick={() => void submit()}
              disabled={busy}
            >
              {t('move.confirm')}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
