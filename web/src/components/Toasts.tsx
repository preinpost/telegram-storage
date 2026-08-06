import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';

export type ToastKind = 'error' | 'success' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  push: (kind: ToastKind, message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++;
    setToasts((all) => [...all, { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((all) => all.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            className={`toast toast-${toast.kind}`}
            onClick={() => setToasts((all) => all.filter((x) => x.id !== toast.id))}
            title={t('common.close')}
          >
            {toast.message}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToasts(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToasts must be used within <ToastProvider>');
  return ctx;
}
