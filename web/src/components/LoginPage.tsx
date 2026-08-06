import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { LANG_LABELS, useI18n, type Lang } from '../i18n';
import type { AuthConfig, User } from '../types';
import { useToasts } from './Toasts';

interface Props {
  config: AuthConfig;
  onLogin: (user: User) => void;
}

interface TelegramAuthData {
  id: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  auth_date: string;
  hash: string;
}

export default function LoginPage({ config, onLogin }: Props) {
  const { lang, setLang, t } = useI18n();
  const toasts = useToasts();

  const handleTelegramAuth = useCallback(
    async (data: TelegramAuthData) => {
      try {
        const fields: Record<string, string> = {
          id: String(data.id),
          auth_date: data.auth_date,
          hash: data.hash,
        };
        if (data.first_name) fields.first_name = data.first_name;
        if (data.last_name) fields.last_name = data.last_name;
        if (data.username) fields.username = data.username;
        const res = await api.telegramLogin(fields);
        onLogin(res.user);
      } catch (err) {
        toasts.push('error', errorMessage(err, t('login.telegramFailed')));
      }
    },
    [onLogin, toasts, t],
  );

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>📁 Telegram Storage</h1>
        <p className="login-sub">{t('login.subtitle')}</p>
        {config.devAuth ? (
          <DevLoginForm onLogin={onLogin} />
        ) : config.botUsername ? (
          <TelegramWidget botUsername={config.botUsername} onAuth={handleTelegramAuth} />
        ) : (
          <p className="login-error">
            {t('login.notConfiguredIntro')} <code>DEV_AUTH=true</code> {t('login.or')}{' '}
            <code>TELEGRAM_BOT_USERNAME</code> {t('login.notConfiguredOutro')}
          </p>
        )}
        <LoginLangSwitcher lang={lang} setLang={setLang} />
      </div>
    </div>
  );
}

/** Compact language switcher shown on the login card (settings modal covers the main app). */
function LoginLangSwitcher({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div className="login-langs">
      {(Object.keys(LANG_LABELS) as Lang[]).map((l) => (
        <button
          key={l}
          type="button"
          className={`lang-link ${lang === l ? 'active' : ''}`}
          onClick={() => setLang(l)}
        >
          {LANG_LABELS[l]}
        </button>
      ))}
    </div>
  );
}

function DevLoginForm({ onLogin }: { onLogin: (user: User) => void }) {
  const t = useI18n().t;
  const toasts = useToasts();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    if (!name) return;
    setBusy(true);
    try {
      const res = await api.devLogin(name, displayName.trim() || undefined);
      onLogin(res.user);
    } catch (err) {
      toasts.push('error', errorMessage(err, t('login.failed')));
      setBusy(false);
    }
  };

  return (
    <form className="login-form" onSubmit={submit}>
      <label className="field">
        <span>{t('login.username')}</span>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('login.usernamePlaceholder')}
          autoFocus
          maxLength={64}
          required
        />
      </label>
      <label className="field">
        <span>{t('login.displayName')}</span>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={64} />
      </label>
      <button type="submit" className="btn btn-primary" disabled={busy || !username.trim()}>
        {busy ? t('login.signingIn') : t('login.signIn')}
      </button>
      <p className="login-hint">{t('login.devModeHint')}</p>
    </form>
  );
}

/**
 * Telegram Login Widget. The widget script reads data-* attributes off its own
 * <script> tag; data-onauth gives us the auth fields client-side so the SPA
 * can POST them itself (the server still verifies the HMAC signature).
 */
function TelegramWidget({
  botUsername,
  onAuth,
}: {
  botUsername: string;
  onAuth: (data: TelegramAuthData) => void;
}) {
  const t = useI18n().t;
  useEffect(() => {
    const w = window as unknown as { onTelegramAuth?: (data: TelegramAuthData) => void };
    w.onTelegramAuth = onAuth;

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-onauth', 'onTelegramAuth');
    script.setAttribute('data-request-access', 'write');
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
      delete w.onTelegramAuth;
    };
  }, [botUsername, onAuth]);

  return (
    <p className="login-hint">
      {t('login.telegramHint1')}
      <br />
      {t('login.telegramHint2')}
    </p>
  );
}
