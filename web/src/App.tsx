import { useEffect, useState } from 'react';
import { api, ApiError, setUnauthorizedHandler } from './api';
import { I18nProvider, useT } from './i18n';
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
      <div className="login-page">
        <div className="login-card">
          <h1>📁 Telegram Storage</h1>
          <p className="login-error">{t('app.bootFailed')}</p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (user === undefined) {
    return (
      <div className="login-page">
        <div className="login-card">
          <p className="login-hint">{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  if (user === null) {
    return config === null ? null : <LoginPage config={config} onLogin={(u) => setUser(u)} />;
  }

  return <Browser user={user} onLogout={handleLogout} />;
}
