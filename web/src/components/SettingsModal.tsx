import { useEffect } from 'react';
import { LANG_LABELS, useI18n, type Lang } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Settings modal (opened from the gear icon in the topbar).
 * Currently holds the language preference; extend with more settings here.
 */
export default function SettingsModal({ open, onClose }: Props) {
  const { lang, setLang, t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

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
