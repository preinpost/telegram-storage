import { useState, type FormEvent } from 'react';
import { useT } from '../i18n';
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
    <div className="perm-panel">
      <div className="perm-header">
        <span className="perm-title">{t('perm.title', { name: folderName })}</span>
        <span className="role-badge admin">{t('role.admin')}</span>
      </div>

      <form className="grant-form" onSubmit={submitGrant}>
        <div className="grant-row">
          <input
            className="grant-user"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder={t('perm.userIdPlaceholder')}
            inputMode="numeric"
            maxLength={12}
          />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`role.${r}`)}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-small btn-primary" disabled={busy || !userId.trim()}>
            {t('perm.grant')}
          </button>
        </div>
      </form>

      <div className="perm-members">
        <div className="perm-member owner" title={t('perm.ownerTitle')}>
          <span>User #{ownerId}</span>
          <span className="role-badge admin">{t('perm.owner')}</span>
        </div>

        {permissions === null && (
          <div className="perm-loading">
            {t('browser.permsLoadFailed')}.{' '}
            <button type="button" className="btn btn-small" onClick={onRetry}>
              {t('common.retry')}
            </button>
          </div>
        )}

        {permissions !== null &&
          permissions.map((p) => (
            <div key={p.id} className="perm-member">
              <span className="perm-user">User #{p.userId}</span>
              <select
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
                className="btn btn-small danger"
                onClick={() => void onRevoke(p.userId)}
              >
                {t('perm.revoke')}
              </button>
            </div>
          ))}
      </div>

      {knownUserIds.length > 0 && (
        <div className="known-users">
          <span className="known-label">{t('perm.knownUsers')}</span>
          {knownUserIds.map((id) => (
            <button
              key={id}
              type="button"
              className="chip"
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
