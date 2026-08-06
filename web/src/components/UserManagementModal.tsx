import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '@base-ui-components/react/dialog';
import { api, errorMessage } from '../api';
import { cn } from '../cn';
import { formatDate } from '../format';
import { langToLocale, useI18n } from '../i18n';
import { btn, btnPrimary, btnSmall, iconBtn, input, roleBadge, roleBadgeAdmin } from '../ui';
import type { UserAdmin, UserRole } from '../types';
import { useToasts } from './Toasts';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Global user management (global admins only). Lists every account and lets an
 * admin promote/demote the global role (member ⇄ admin) or copy a user's
 * numeric id (used to grant folder permissions).
 *
 * Built on Base UI's headless Dialog — ESC / backdrop click close, focus trap
 * and scroll lock are handled by the primitive.
 */
export default function UserManagementModal({ open, onClose }: Props) {
  const { lang, t } = useI18n();
  const toasts = useToasts();
  const [users, setUsers] = useState<UserAdmin[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copyBusy, setCopyBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setUsers(null);
    try {
      const res = await api.users();
      setUsers(res.users);
    } catch (err) {
      setUsers([]);
      toasts.push('error', errorMessage(err, t('users.loadFailed')));
    }
  }, [toasts, t]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const changeRole = async (u: UserAdmin, role: UserRole) => {
    if (u.role === role) return;
    setBusyId(u.id);
    try {
      await api.updateUserRole(u.id, role);
      toasts.push('success', t('users.roleUpdated', { name: u.displayName || u.username, role: t(`role.${role}`) }));
      await load();
    } catch (err) {
      toasts.push('error', errorMessage(err, t('users.roleUpdateFailed')));
    } finally {
      setBusyId(null);
    }
  };

  const copyId = async (u: UserAdmin) => {
    setCopyBusy(u.id);
    try {
      await navigator.clipboard.writeText(u.id);
      toasts.push('success', t('users.copied', { name: u.displayName || u.username }));
    } catch {
      toasts.push('error', t('users.copyId'));
    } finally {
      setCopyBusy(null);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[900] flex items-center justify-center bg-[rgba(16,24,40,0.45)] p-4 transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-[910] w-full max-w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-modal outline-none transition-all duration-150 data-[starting-style]:translate-y-[calc(-50%+6px)] data-[starting-style]:opacity-0 data-[ending-style]:translate-y-[calc(-50%+6px)] data-[ending-style]:opacity-0">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="m-0 text-lg font-bold">👥 {t('users.title')}</Dialog.Title>
            <Dialog.Close className={iconBtn} title={t('common.close')}>
              ✕
            </Dialog.Close>
          </div>

          <div className="flex max-h-[55vh] flex-col gap-1.5 overflow-y-auto pr-1">
            {users === null && <span className="text-xs text-muted">{t('common.loading')}</span>}
            {users !== null && users.length === 0 && (
              <span className="text-xs text-muted">{t('users.empty')}</span>
            )}
            {users !== null &&
              users.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-row-alt px-2 py-2"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-semibold" title={u.displayName || u.username}>
                        {u.displayName || u.username}
                      </span>
                      <span className={cn(roleBadge, u.role === 'admin' && roleBadgeAdmin)}>
                        {t(`role.${u.role}`)}
                      </span>
                    </div>
                    <div className="flex min-w-0 gap-2 truncate text-xs text-muted">
                      <span className="truncate" title={`@${u.username}`}>
                        @{u.username}
                      </span>
                      <span className="whitespace-nowrap">#{u.id}</span>
                      <span className="whitespace-nowrap">{formatDate(u.createdAt, langToLocale(lang))}</span>
                      {u.telegramId !== null && <span className="whitespace-nowrap">{t('users.telegram')}</span>}
                    </div>
                  </div>

                  <select
                    className={`${input} w-[96px] shrink-0 px-2 py-1 text-xs`}
                    value={u.role}
                    disabled={busyId === u.id}
                    onChange={(e) => void changeRole(u, e.target.value as UserRole)}
                    title={`${t('users.role')}: ${u.displayName || u.username}`}
                    aria-label={`${t('users.role')}: ${u.displayName || u.username}`}
                  >
                    <option value="member">{t('role.member')}</option>
                    <option value="admin">{t('role.admin')}</option>
                  </select>

                  <button
                    type="button"
                    className={`${btn} ${btnSmall} shrink-0 ${copyBusy === u.id ? 'opacity-60' : ''}`}
                    title={t('users.copyId')}
                    onClick={() => void copyId(u)}
                  >
                    {t('users.copyId')}
                  </button>
                </div>
              ))}
          </div>

          <div className="mt-[18px] flex justify-end">
            <Dialog.Close className={`${btn} ${btnPrimary}`}>{t('common.close')}</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
