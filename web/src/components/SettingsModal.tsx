import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatBytes } from '../format';
import { LANG_LABELS, useI18n, type Lang } from '../i18n';
import type { Stats } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Settings modal (opened from the gear icon in the topbar).
 * Language preference + storage usage overview.
 */
export default function SettingsModal({ open, onClose }: Props) {
  const { lang, setLang, t } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

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

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>⚙️ {t('settings.title')}</h2>
          <button type="button" className="icon-btn" title={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="settings-group">
            <span className="settings-label">{t('settings.language')}</span>
            <div className="lang-options">
              {(Object.keys(LANG_LABELS) as Lang[]).map((l) => (
                <button
                  key={l}
                  type="button"
                  className={`lang-option ${lang === l ? 'active' : ''}`}
                  onClick={() => setLang(l)}
                >
                  {LANG_LABELS[l]}
                </button>
              ))}
            </div>
          </div>
          {stats !== null && (
            <div className="settings-group">
              <span className="settings-label">{t('settings.storage')}</span>
              <div className="stats-grid">
                <div className="stats-item">
                  <span>{t('settings.totalSize')}</span>
                  <strong>{formatBytes(stats.totalSize)}</strong>
                </div>
                <div className="stats-item">
                  <span>{t('settings.fileCount')}</span>
                  <strong>{stats.fileCount}</strong>
                </div>
                <div className="stats-item">
                  <span>{t('settings.folderCount')}</span>
                  <strong>{stats.folderCount}</strong>
                </div>
                <div className="stats-item">
                  <span>{t('settings.userCount')}</span>
                  <strong>{stats.userCount}</strong>
                </div>
              </div>
              {stats.folderUsage.length > 0 && (
                <>
                  <span className="settings-label">{t('settings.byFolder')}</span>
                  <ul className="stats-folder-list">
                    {stats.folderUsage.map((u) => (
                      <li key={u.folderId ?? 'root'}>
                        <span className="stats-folder-name" title={u.name}>
                          {u.folderId === null ? t('common.root') : u.name}
                        </span>
                        <span className="stats-folder-size">
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
        <div className="modal-footer">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
