import { useEffect, useState } from 'react';
import { Dialog } from '@base-ui-components/react/dialog';
import { api } from '../api';
import { cn } from '../cn';
import { formatBytes } from '../format';
import { LANG_LABELS, useI18n, type Lang } from '../i18n';
import { btn, btnPrimary, iconBtn } from '../ui';
import type { Stats } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Settings modal (opened from the gear icon in the topbar).
 * Language preference + storage usage overview.
 *
 * Built on Base UI's headless Dialog: ESC / backdrop click close, focus trap
 * and scroll lock are handled by the primitive.
 */
export default function SettingsModal({ open, onClose }: Props) {
  const { lang, setLang, t } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);

  // Storage stats are best-effort — hide the section quietly on failure.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStats(null);
    void api
      .stats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        // non-fatal: leave stats null (section hidden)
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[900] flex items-center justify-center bg-[rgba(16,24,40,0.45)] p-4 transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-[910] w-full max-w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-modal outline-none transition-all duration-150 data-[starting-style]:translate-y-[calc(-50%+6px)] data-[starting-style]:opacity-0 data-[ending-style]:translate-y-[calc(-50%+6px)] data-[ending-style]:opacity-0">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="m-0 text-lg font-bold">⚙️ {t('settings.title')}</Dialog.Title>
            <Dialog.Close className={iconBtn} title={t('common.close')}>
              ✕
            </Dialog.Close>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <span className="text-xs text-muted">{t('settings.language')}</span>
              <div className="flex gap-2" role="radiogroup" aria-label={t('settings.language')}>
                {(Object.keys(LANG_LABELS) as Lang[]).map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="radio"
                    aria-checked={lang === l}
                    className={cn(
                      'flex-1 cursor-pointer rounded-lg border border-border bg-white px-2.5 py-2 text-[13px] hover:border-accent',
                      lang === l && 'border-accent bg-accent text-white',
                    )}
                    onClick={() => setLang(l)}
                  >
                    {LANG_LABELS[l]}
                  </button>
                ))}
              </div>
            </div>
            {stats !== null && (
              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted">{t('settings.storage')}</span>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-0.5 rounded-lg bg-bg px-2.5 py-2 text-xs text-muted">
                    <span>{t('settings.totalSize')}</span>
                    <strong className="text-[15px] text-text">{formatBytes(stats.totalSize)}</strong>
                  </div>
                  <div className="flex flex-col gap-0.5 rounded-lg bg-bg px-2.5 py-2 text-xs text-muted">
                    <span>{t('settings.fileCount')}</span>
                    <strong className="text-[15px] text-text">{stats.fileCount}</strong>
                  </div>
                  <div className="flex flex-col gap-0.5 rounded-lg bg-bg px-2.5 py-2 text-xs text-muted">
                    <span>{t('settings.folderCount')}</span>
                    <strong className="text-[15px] text-text">{stats.folderCount}</strong>
                  </div>
                  <div className="flex flex-col gap-0.5 rounded-lg bg-bg px-2.5 py-2 text-xs text-muted">
                    <span>{t('settings.userCount')}</span>
                    <strong className="text-[15px] text-text">{stats.userCount}</strong>
                  </div>
                </div>
                {stats.folderUsage.length > 0 && (
                  <>
                    <span className="text-xs text-muted">{t('settings.byFolder')}</span>
                    <ul className="m-0 flex max-h-[160px] list-none flex-col gap-1 overflow-y-auto p-0 text-xs">
                      {stats.folderUsage.map((u) => (
                        <li key={u.folderId ?? 'root'} className="flex justify-between gap-2">
                          <span className="truncate" title={u.name}>
                            {u.folderId === null ? t('common.root') : u.name}
                          </span>
                          <span className="whitespace-nowrap text-muted">
                            {formatBytes(u.size)} · {u.fileCount}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="mt-[18px] flex justify-end">
            <Dialog.Close className={`${btn} ${btnPrimary}`}>{t('common.close')}</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
