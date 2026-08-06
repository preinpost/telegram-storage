import { useEffect, useState } from 'react';
import { api, ApiError, setUnauthorizedHandler } from './api';
import { I18nProvider, useT } from './i18n';
import { btn, btnPrimary } from './ui';
import type { AuthConfig, User } from './types';
import Browser from './components/Browser';
import LoginPage from './components/LoginPage';
import { ToastProvider, useToasts } from './components/Toasts';

export default function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <Root />
      </ToastProvider>
    </I18nProvider>
  );
}

function Root() {
  const t = useT();
  const toasts = useToasts();
  const [config, setConfig] = useState<AuthConfig | null>(null);
  // undefined = still checking session; null = not logged in
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [bootFailed, setBootFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Any API 401 (expired session) drops the user back to the login screen.
    setUnauthorizedHandler(() => {
      if (!cancelled) setUser(null);
    });

    void (async () => {
      try {
        const cfg = await api.config();
        if (!cancelled) setConfig(cfg);
      } catch {
        if (!cancelled) {
          setBootFailed(true);
          setUser(null);
        }
        return;
      }
      try {
        const me = await api.me();
        if (!cancelled) setUser(me.user);
      } catch (err) {
        if (!cancelled) {
          if (!(err instanceof ApiError) || err.status !== 401) {
            toasts.push(
              'error',
              t('app.authCheckFailed', {
                message: err instanceof Error ? err.message : String(err),
              }),
            );
          }
          setUser(null);
        }
      }
    })();

    return () => {
      cancelled = true;
      setUnauthorizedHandler(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      // session is gone anyway — just clear local state
    }
    setUser(null);
  };

  if (bootFailed) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="w-full max-w-[380px] rounded-xl border border-border bg-panel p-8 text-center shadow-card">
          <h1 className="mb-1 text-[22px] font-bold">📁 Telegram Storage</h1>
          <p className="break-all rounded-lg border border-danger-line bg-danger-bg p-2.5 text-[13px] text-danger-strong">
            {t('app.bootFailed')}
          </p>
          <button type="button" className={`${btn} ${btnPrimary} mt-3`} onClick={() => window.location.reload()}>
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (user === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="w-full max-w-[380px] rounded-xl border border-border bg-panel p-8 text-center shadow-card">
          <p className="mt-3 text-xs text-muted">{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  if (user === null) {
    return config === null ? null : <LoginPage config={config} onLogin={(u) => setUser(u)} />;
  }

  return <Browser user={user} onLogout={handleLogout} />;
}
