import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { useI18n } from '../i18n';
import { btn, btnPrimary, input } from '../ui';
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
  const t = useI18n().t;
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
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-[380px] rounded-xl border border-border bg-panel p-8 text-center shadow-card">
        <h1 className="mb-1 text-[22px] font-bold">📁 Telegram Storage</h1>
        <p className="mb-5 text-muted">{t('login.subtitle')}</p>
        {config.devAuth ? (
          <DevLoginForm onLogin={onLogin} />
        ) : config.botUsername ? (
          <TelegramWidget botUsername={config.botUsername} onAuth={handleTelegramAuth} />
        ) : (
          <p className="break-all rounded-lg border border-danger-line bg-danger-bg p-2.5 text-[13px] text-danger-strong">
            {t('login.notConfiguredIntro')} <code>DEV_AUTH=true</code> {t('login.or')}{' '}
            <code>TELEGRAM_BOT_USERNAME</code> {t('login.notConfiguredOutro')}
          </p>
        )}
      </div>
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
    <form className="flex flex-col gap-3 text-left" onSubmit={submit}>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">{t('login.username')}</span>
        <input
          className={input}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('login.usernamePlaceholder')}
          autoFocus
          maxLength={64}
          required
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">{t('login.displayName')}</span>
        <input className={input} value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={64} />
      </label>
      <button type="submit" className={`${btn} ${btnPrimary} justify-center`} disabled={busy || !username.trim()}>
        {busy ? t('login.signingIn') : t('login.signIn')}
      </button>
      <p className="mt-3 text-xs text-muted">{t('login.devModeHint')}</p>
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
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const w = window as unknown as { onTelegramAuth?: (data: TelegramAuthData) => void };
    w.onTelegramAuth = onAuth;

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-onauth', 'onTelegramAuth');
    script.setAttribute('data-request-access', 'write');
    // telegram-widget.js 는 자기 script 태그 위치에 iframe 을 삽입한다.
    // body 끝에 붙이면 버튼이 카드 밖(페이지 하단)으로 밀려나므로, 카드 안
    // 컨테이너에 붙여 버튼이 로그인 카드 안에 표시되게 한다.
    containerRef.current?.appendChild(script);

    return () => {
      containerRef.current?.removeChild(script);
      delete w.onTelegramAuth;
    };
  }, [botUsername, onAuth]);

  return (
    <>
      <div ref={containerRef} className="mb-4 flex justify-center" />
      <p className="mt-3 text-xs text-muted">
        {t('login.telegramHint1')}
        <br />
        {t('login.telegramHint2')}
      </p>
    </>
  );
}
