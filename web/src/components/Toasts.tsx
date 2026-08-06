import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { Toast } from '@base-ui-components/react/toast';
import { cn } from '../cn';
import { useT } from '../i18n';
import { iconBtn } from '../ui';

export type ToastKind = 'error' | 'success' | 'info';

interface ToastApi {
  push: (kind: ToastKind, message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Toast host built on Base UI's headless Toast primitives (provider, viewport,
 * root, title, close). Base UI handles mount/unmount, auto-dismiss timeouts,
 * enter/exit transition attributes (`data-starting-style` / `data-ending-style`)
 * and the `data-type` attribute used for kind-specific styling.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider timeout={6000} limit={5}>
      <ToastHost>{children}</ToastHost>
    </Toast.Provider>
  );
}

function ToastHost({ children }: { children: ReactNode }) {
  const { toasts, add, close } = Toast.useToastManager();
  const t = useT();

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      add({ title: message, type: kind });
    },
    [add],
  );

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <Toast.Viewport className="fixed top-3.5 right-3.5 z-[1000] flex max-w-[380px] flex-col gap-2 outline-none">
        {toasts.map((toast) => (
          <Toast.Root
            key={toast.id}
            toast={toast}
            onClick={() => close(toast.id)}
            className={cn(
              'relative cursor-pointer rounded-lg border border-border bg-panel p-3.5 text-left shadow-card',
              'transition-all duration-200 ease-out',
              'data-[starting-style]:-translate-y-1 data-[starting-style]:opacity-0',
              'data-[ending-style]:-translate-y-1 data-[ending-style]:opacity-0',
              'data-[type=error]:border-danger-line data-[type=error]:bg-danger-bg data-[type=error]:text-danger-strong',
              'data-[type=success]:border-ok-line data-[type=success]:bg-ok-bg data-[type=success]:text-ok-strong',
              'data-[type=info]:border-info-line data-[type=info]:bg-info-bg data-[type=info]:text-info-strong',
            )}
          >
            <Toast.Title className="pr-4 text-sm font-normal">{toast.title}</Toast.Title>
            <Toast.Close className={cn(iconBtn, 'absolute top-1 right-1.5')} title={t('common.close')}>
              ✕
            </Toast.Close>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </ToastContext.Provider>
  );
}

export function useToasts(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToasts must be used within <ToastProvider>');
  return ctx;
}
