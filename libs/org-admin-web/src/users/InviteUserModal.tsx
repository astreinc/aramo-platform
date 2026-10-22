import { useEffect, useState } from 'react';
import { ApiError, fetchMyProducts, safeErrorMessage, useToast } from '@aramo/fe-foundation';

import { fetchMe } from '../me-api';
import { fetchRolesCatalog } from '../roles/roles-catalog-api';
import { OrgModal } from '../ui/OrgPage';

import { messageForInviteError } from './error-messages';
import { buildRoleGroups, subscribedApps, type RoleGroup } from './role-groups';
import { RoleGroupsPicker } from './RoleGroupsPicker';
import type { TenantUserView } from './types';
import { fetchTenantUsers, inviteTenantUser } from './users-api';

// ORG-UX-1 (handoff §6.3 Invite user form; Directive v1.0 LOCKED §4.4) — the Invite user
// modal, shared by Users & invitations, Overview and App Home's Shortcuts. Standalone: it
// loads the role catalog, the tenant's subscribed apps, the roster (the "already in your
// organization" check) and /v1/me (whether the caller is an owner) itself.
// Needs at least one role; preselects nothing. POST /v1/tenant/users/invitations (the
// server writes the audit entry).
export interface InviteUserModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Called after a successful invitation (the caller refreshes its data). */
  readonly onInvited?: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Loaded =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly groups: readonly RoleGroup[]; readonly users: readonly TenantUserView[]; readonly callerIsOwner: boolean };

export function InviteUserModal({ open, onOpenChange, onInvited }: InviteUserModalProps) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<readonly string[]>([]);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    setEmail('');
    setName('');
    setRoles([]);
    setEmailError(null);
    setFormError(null);
    setSending(false);
    let cancelled = false;
    setLoaded({ status: 'loading' });
    Promise.all([fetchRolesCatalog(), fetchMyProducts().catch(() => null), fetchTenantUsers(), fetchMe().catch(() => null)])
      .then(([catalog, products, list, me]) => {
        if (cancelled) return;
        const myEmail = me?.user.email.toLowerCase() ?? null;
        const self = myEmail === null ? undefined : list.items.find((u) => u.email.toLowerCase() === myEmail);
        setLoaded({
          status: 'ready',
          groups: buildRoleGroups(catalog, subscribedApps(products)),
          users: list.items,
          callerIsOwner: self?.role_keys.includes('tenant_owner') === true,
        });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [open, attempt]);

  const send = async () => {
    if (sending || loaded.status !== 'ready') return;
    const em = email.trim().toLowerCase();
    if (!EMAIL_RE.test(em)) {
      setEmailError('Enter a work email address.');
      return;
    }
    if (loaded.users.some((u) => u.email.toLowerCase() === em)) {
      setEmailError('This person is already in your organization.');
      return;
    }
    if (roles.length === 0) {
      setFormError('Select at least one role.');
      return;
    }
    setSending(true);
    setFormError(null);
    try {
      await inviteTenantUser({ email: em, display_name: name.trim().length > 0 ? name.trim() : null, role_keys: roles });
      toast.show(`Invitation sent to ${em}.`);
      onInvited?.();
      onOpenChange(false);
    } catch (err: unknown) {
      setSending(false);
      if (err instanceof ApiError && err.status === 409) {
        setEmailError('This person is already in your organization.');
        return;
      }
      const m = err instanceof ApiError ? messageForInviteError(err) : { title: safeErrorMessage(err, 'Something went wrong. Please try again.') };
      setFormError(m.detail !== undefined ? `${m.title} ${m.detail}` : m.title);
    }
  };

  return (
    <OrgModal
      open={open}
      onOpenChange={onOpenChange}
      testId="invite-user-modal"
      title="Invite user"
      subtitle="They get an email invitation and sign in with their work account. Aramo never creates passwords."
      footer={
        <>
          <button type="button" className="ox-btn ox-btn--secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="ox-btn ox-btn--primary"
            disabled={sending || loaded.status !== 'ready' || roles.length === 0}
            onClick={() => void send()}
            data-testid="send-invitation"
          >
            Send invitation
          </button>
        </>
      }
    >
      <label className="ox-field">
        <span className="ox-label">Work email</span>
        <input
          className={`ox-input${emailError !== null ? ' ox-input--error' : ''}`}
          type="email"
          required
          value={email}
          placeholder="name@company.com"
          aria-invalid={emailError !== null}
          data-testid="invite-email"
          onChange={(e) => {
            setEmail(e.target.value);
            setEmailError(null);
          }}
        />
        {emailError !== null ? (
          <span className="ox-error" role="alert">
            {emailError}
          </span>
        ) : null}
      </label>
      <label className="ox-field">
        <span className="ox-label">Full name</span>
        <input className="ox-input" value={name} placeholder="First and last name" data-testid="invite-name" onChange={(e) => setName(e.target.value)} />
      </label>
      {loaded.status === 'loading' ? <p className="ox-muted" aria-busy="true">Loading roles…</p> : null}
      {loaded.status === 'error' ? (
        <div className="ox-alert ox-alert--error" role="alert">
          We couldn’t load the roles.{' '}
          <button type="button" className="ox-link" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : null}
      {loaded.status === 'ready' ? (
        <RoleGroupsPicker
          groups={loaded.groups}
          selected={roles}
          onChange={(next) => {
            setRoles(next);
            setFormError(null);
          }}
          callerIsOwner={loaded.callerIsOwner}
        />
      ) : null}
      {formError !== null ? (
        <div className="ox-alert ox-alert--error" role="alert">
          {formError}
        </div>
      ) : null}
    </OrgModal>
  );
}
