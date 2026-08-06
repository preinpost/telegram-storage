import { useState, type FormEvent } from 'react';
import { cn } from '../cn';
import { useT } from '../i18n';
import { btn, btnDanger, btnPrimary, btnSmall, chip, input, roleBadge, roleBadgeAdmin } from '../ui';
import type { Permission, Role } from '../types';
import { useToasts } from './Toasts';

const ROLES: Role[] = ['read', 'write', 'admin'];

interface Props {
  folderName: string;
  ownerId: string;
  permissions: Permission[] | null;
  knownUserIds: string[];
  onGrant: (userId: string, role: Role) => void | Promise<void>;
  onRevoke: (userId: string) => void | Promise<void>;
  onRetry: () => void;
}

/**
 * Permission management for the selected folder (only reachable by admins —
 * the backend enforces the admin gate regardless of the UI).
 *
 * Note: the M3 API contract exposes only user *ids* (no /api/users endpoint),
 * so members are shown as "User #id" and a new grant needs the target user's
 * numeric id (e.g. from /api/auth/me of that user, or the known-id chips
 * collected from folder owners / existing grants).
 */
export default function PermissionsPanel({
  folderName,
  ownerId,
  permissions,
  knownUserIds,
  onGrant,
  onRevoke,
  onRetry,
}: Props) {
  const t = useT();
  const toasts = useToasts();
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<Role>('read');
  const [busy, setBusy] = useState(false);

  const submitGrant = async (e: FormEvent) => {
    e.preventDefault();
    const id = userId.trim();
    if (!/^\d+$/.test(id)) {
      toasts.push('error', t('perm.userIdNumeric'));
      return;
    }
    setBusy(true);
    try {
      await onGrant(id, role);
      setUserId('');
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (perm: Permission, newRole: Role) => {
    if (newRole === perm.role) return;
    try {
      await onGrant(perm.userId, newRole);
    } catch {
      // error toast handled by the caller
    }
  };

  return (
    <div className="flex w-[300px] flex-col gap-2.5 overflow-auto rounded-lg border border-border bg-panel p-3 shadow-card">
      <div className="flex items-center gap-2">
        <span className="truncate font-bold">{t('perm.title', { name: folderName })}</span>
        <span className={cn(roleBadge, roleBadgeAdmin)}>{t('role.admin')}</span>
      </div>

      <form className="flex flex-col gap-1.5" onSubmit={submitGrant}>
        <div className="flex items-center gap-1.5">
          <input
            className={`${input} min-w-0 flex-1`}
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder={t('perm.userIdPlaceholder')}
            inputMode="numeric"
            maxLength={12}
          />
          <select className="rounded-lg border border-border bg-white px-1.5 py-[7px] text-xs" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`role.${r}`)}
              </option>
            ))}
          </select>
          <button type="submit" className={`${btn} ${btnSmall} ${btnPrimary}`} disabled={busy || !userId.trim()}>
            {t('perm.grant')}
          </button>
        </div>
      </form>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 rounded-lg border border-warn-line bg-warn-bg px-2 py-1.5" title={t('perm.ownerTitle')}>
          <span>User #{ownerId}</span>
          <span className={cn(roleBadge, roleBadgeAdmin)}>{t('perm.owner')}</span>
        </div>

        {permissions === null && (
          <div className="text-xs text-muted">
            {t('browser.permsLoadFailed')}.{' '}
            <button type="button" className={`${btn} ${btnSmall}`} onClick={onRetry}>
              {t('common.retry')}
            </button>
          </div>
        )}

        {permissions !== null &&
          permissions.map((p) => (
            <div key={p.id} className="flex items-center gap-1.5 rounded-lg border border-border bg-row-alt px-2 py-1.5">
              <span className="flex-1 truncate font-semibold">User #{p.userId}</span>
              <select
                className="rounded-lg border border-border bg-white px-1.5 py-0.5 text-xs"
                value={p.role}
                onChange={(e) => changeRole(p, e.target.value as Role)}
                title={t('perm.changeRole')}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`role.${r}`)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`${btn} ${btnSmall} ${btnDanger}`}
                onClick={() => void onRevoke(p.userId)}
              >
                {t('perm.revoke')}
              </button>
            </div>
          ))}
      </div>

      {knownUserIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-dashed border-border pt-2">
          <span className="text-xs text-muted">{t('perm.knownUsers')}</span>
          {knownUserIds.map((id) => (
            <button
              key={id}
              type="button"
              className={chip}
              title={t('perm.knownUsersTitle')}
              onClick={() => setUserId(id)}
            >
              User #{id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
