import { useState, type FormEvent } from 'react';
import { ROLE_LABEL, type Permission, type Role } from '../types';
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
  const toasts = useToasts();
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<Role>('read');
  const [busy, setBusy] = useState(false);

  const submitGrant = async (e: FormEvent) => {
    e.preventDefault();
    const id = userId.trim();
    if (!/^\d+$/.test(id)) {
      toasts.push('error', '사용자 ID는 숫자여야 합니다');
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
        <span className="perm-title">권한 — {folderName}</span>
        <span className="role-badge admin">관리</span>
      </div>

      <form className="grant-form" onSubmit={submitGrant}>
        <div className="grant-row">
          <input
            className="grant-user"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="사용자 ID (숫자)"
            inputMode="numeric"
            maxLength={12}
          />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-small btn-primary" disabled={busy || !userId.trim()}>
            부여
          </button>
        </div>
      </form>

      <div className="perm-members">
        <div className="perm-member owner" title="폴더 소유자는 항상 admin (변경/회수 불가)">
          <span>User #{ownerId}</span>
          <span className="role-badge admin">소유자</span>
        </div>

        {permissions === null && (
          <div className="perm-loading">
            권한 목록을 불러오지 못했습니다.{' '}
            <button type="button" className="btn btn-small" onClick={onRetry}>
              다시 시도
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
                title="역할 변경"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-small danger"
                onClick={() => void onRevoke(p.userId)}
              >
                회수
              </button>
            </div>
          ))}
      </div>

      {knownUserIds.length > 0 && (
        <div className="known-users">
          <span className="known-label">알려진 사용자:</span>
          {knownUserIds.map((id) => (
            <button
              key={id}
              type="button"
              className="chip"
              title="클릭해 부여 폼에 채우기"
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
