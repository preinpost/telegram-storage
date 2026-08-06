import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
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
        toasts.push('error', errorMessage(err, '텔레그램 로그인에 실패했습니다'));
      }
    },
    [onLogin, toasts],
  );

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>📁 Telegram Storage</h1>
        <p className="login-sub">팀 파일 저장소</p>
        {config.devAuth ? (
          <DevLoginForm onLogin={onLogin} />
        ) : config.botUsername ? (
          <TelegramWidget botUsername={config.botUsername} onAuth={handleTelegramAuth} />
        ) : (
          <p className="login-error">
            로그인 방법이 구성되지 않았습니다. 서버에서 <code>DEV_AUTH=true</code> 또는{' '}
            <code>TELEGRAM_BOT_USERNAME</code>을 설정하세요.
          </p>
        )}
      </div>
    </div>
  );
}

function DevLoginForm({ onLogin }: { onLogin: (user: User) => void }) {
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
      toasts.push('error', errorMessage(err, '로그인에 실패했습니다'));
      setBusy(false);
    }
  };

  return (
    <form className="login-form" onSubmit={submit}>
      <label className="field">
        <span>사용자 이름</span>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="예: alice"
          autoFocus
          maxLength={64}
          required
        />
      </label>
      <label className="field">
        <span>표시 이름 (선택)</span>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={64} />
      </label>
      <button type="submit" className="btn btn-primary" disabled={busy || !username.trim()}>
        {busy ? '로그인 중…' : '로그인'}
      </button>
      <p className="login-hint">개발 모드 (DEV_AUTH=true) — 첫 로그인 사용자는 admin이 됩니다.</p>
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
      텔레그램 계정으로 로그인하세요.
      <br />
      (위젯이 표시되지 않으면 @BotFather에서 /setdomain 을 확인하세요)
    </p>
  );
}
