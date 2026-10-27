import { useId, useState } from 'react';
import { Button, Input, Select, hasScope, useOptionalToast, type Session } from '@aramo/fe-foundation';

import { ConfirmDialog, TypedConfirm, typedConfirmMatches } from '../components';
import { CommercialRolesSection } from '../commercial-governance/CommercialRolesSection';
import { COMMERCIAL_ROLES, isAttestedOwner, roleLabel } from '../commercial-governance/governance-model';

import {
  HUMAN_REF_HINT,
  STAFF_EMAIL_HINT,
  adminInviteErrorText,
  adminsApi,
  isHumanRefHash,
  isStaffEmail,
} from './admins-api';
import './admins.css';

// PLATFORM-UX-1 F-8 (handoff §9 Platform admins; directive R-8, R-12, R-13) —
// /admins, gated on platform:admin:invite in App.tsx. The invite card mirrors
// the @aramo.ai staff-email rule (the server enforces it, B-1c); "Review
// invitation…" opens a privileged confirm that unlocks only once the operator
// types the email back (TypedConfirm). There is no endpoint that lists platform
// admins, so the list card is the designed empty state (data gap, R-13).
//
// CCP-B5 (handoff §5.8 "extends the existing page"): an operator holding a commercial role
// (platform:approval:read) sees the commercial roles — the approval-chain panel and the
// roster, with governed role-change requests — through GET /platform/commercial/operators.
// super_admin holds no commercial scope (INV-1), so its page is unchanged; an operator who
// is both (the bootstrap operator) sees the commercial roles and the invite card.
//
// CCP-INV-UI-1 (LOCKED 2026-10-26): an attested platform_owner may invite a NEW member straight
// into one platform role, a commercial one included, with that person's D9 identity reference
// hash — the server already accepts it (CCP-A9). Anyone else (super_admin included) gets the
// unchanged super_admin-only dialog; while the roster is loading or failed, the picker is hidden.

export function PlatformAdminsView({ session }: { readonly session?: Session } = {}) {
  if (session !== undefined && hasScope(session, 'platform:approval:read')) {
    return <CommercialPlatformAdminsView session={session} />;
  }
  return <LegacyPlatformAdminsView />;
}

function CommercialPlatformAdminsView({ session }: { readonly session: Session }) {
  const [owner, setOwner] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  return (
      <div className="pw-gov" data-testid="platform-admins">
        <div className="pw-gov-head">
          <h1 className="pw-gov-title">Platform admins</h1>
          <p className="pw-gov-intro">
            Aramo staff and their commercial roles. Super admin runs tenant operations but holds no
            commercial authority. Role changes are change requests approved by a different Platform
            owner.
          </p>
        </div>
        <CommercialRolesSection
          session={session}
          reloadKey={reloadKey}
          onRoster={(r) => setOwner(isAttestedOwner(r, session.sub))}
        />
        {hasScope(session, 'platform:admin:invite') ? (
          <div className="pw-ad-grid pw-gov-gap-top">
            <InviteAdminCard
              commercialRoles={owner}
              onInvited={(role) => {
                if (role !== SUPER_ADMIN) setReloadKey((k) => k + 1);
              }}
            />
          </div>
        ) : null}
      </div>
  );
}

/** The PLATFORM-UX-1 page (super_admin), unchanged. */
function LegacyPlatformAdminsView() {
  return (
    <div className="pw-ad" data-testid="platform-admins">
      <div className="pw-ad-head">
        <h1 className="pw-ad-title">Platform admins</h1>
        <p className="pw-ad-intro">Aramo staff who can operate this console.</p>
      </div>
      <div className="pw-ad-grid">
        <InviteAdminCard />
        <section className="pw-ad-empty" aria-labelledby="pw-ad-list-title">
          <b id="pw-ad-list-title">Current platform admins</b>
          <p className="pw-ad-empty__body">
            The list of current platform admins isn&apos;t available yet.
          </p>
        </section>
      </div>
    </div>
  );
}

const SUPER_ADMIN = 'super_admin';

/** R-5: what each invitable role may do (super_admin keeps the PLATFORM-UX-1 sentence). */
const ROLE_CONSEQUENCE: Readonly<Record<string, string>> = {
  super_admin:
    'This person joins the Aramo Platform tenant as Super admin, with all 10 platform permissions: they can provision, suspend and close any tenant.',
  platform_owner:
    'This person joins as Platform owner: full commercial authority. They approve catalog publishing, policy and role changes, and can invite commercial roles.',
  finance_admin:
    'This person joins as Finance admin: they approve subscription, billing and policy requests, and see Finance amounts.',
  commercial_ops: 'This person joins as Commercial ops: they request subscription changes and record payments.',
  catalog_manager: 'This person joins as Catalog manager: they draft plan versions and request publishing.',
  support_admin: 'This person joins as Support admin: they request bounded support extensions.',
  read_only_auditor: 'This person joins as Read-only auditor: they read commercial records and the audit trail.',
};

function InviteAdminCard({
  commercialRoles = false,
  onInvited,
}: {
  /** R-3: true only for an attested platform_owner (the roster says so). */
  readonly commercialRoles?: boolean;
  readonly onInvited?: (role: string) => void;
} = {}) {
  const toast = useOptionalToast();
  const emailId = useId();
  const nameId = useId();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const hint = email !== '' && !isStaffEmail(email) ? STAFF_EMAIL_HINT : '';

  const review = (): void => {
    const e = email.trim().toLowerCase();
    if (!isStaffEmail(e)) return;
    setReviewing(e);
  };

  return (
    <>
      <section className="pw-ad-card" aria-labelledby="pw-ad-invite-title">
        <div className="pw-ad-card__head">
          <span className="pw-ad-diamond" aria-hidden="true" />
          <h2 id="pw-ad-invite-title" className="pw-ad-card__title">
            Invite platform admin
          </h2>
        </div>
        {commercialRoles ? (
          <p className="pw-ad-card__sub">
            As Platform owner you choose the role in the review step: <b>Super admin</b> or a
            commercial role.
          </p>
        ) : (
          <p className="pw-ad-card__sub">
            The invitee joins the Aramo Platform tenant as <b>Super admin</b> — the highest privilege
            on the platform.
          </p>
        )}
        {done !== null ? (
          <div role="status" className="pw-alert pw-alert--success pw-ad-done">
            Invitation sent to <span className="pw-mono">{done}</span>.
          </div>
        ) : null}
        <div className="pw-ad-fields">
          <label className="pw-ad-field" htmlFor={emailId}>
            <span className="pw-field__label">Staff email</span>
            <Input
              id={emailId}
              unstyled
              className="pw-input"
              type="email"
              placeholder="name@aramo.ai"
              value={email}
              aria-invalid={hint !== '' || undefined}
              aria-describedby={`${emailId}-hint`}
              onChange={(e) => {
                setEmail(e.target.value);
                setDone(null);
              }}
            />
            <span id={`${emailId}-hint`} className="pw-ad-hint" aria-live="polite">
              {hint}
            </span>
          </label>
          <label className="pw-ad-field" htmlFor={nameId}>
            <span className="pw-field__label">Display name</span>
            <Input
              id={nameId}
              unstyled
              className="pw-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>
        <div className="pw-ad-actions">
          <Button unstyled className="pw-btn pw-btn--privileged" onClick={review}>
            Review invitation…
          </Button>
        </div>
      </section>
      {reviewing !== null ? (
        <InviteAdminDialog
          email={reviewing}
          displayName={name.trim()}
          commercialRoles={commercialRoles}
          onClose={() => setReviewing(null)}
          onSent={(sent, role) => {
            setReviewing(null);
            setEmail('');
            setName('');
            setDone(sent);
            toast.show(
              role === SUPER_ADMIN
                ? `Platform admin invitation sent to ${sent}.`
                : `${roleLabel(role)} invitation sent to ${sent}.`,
            );
            onInvited?.(role);
          }}
        />
      ) : null}
    </>
  );
}

export function InviteAdminDialog({
  email,
  displayName,
  commercialRoles = false,
  onClose,
  onSent,
}: {
  readonly email: string;
  readonly displayName: string;
  /** R-3: show the role picker (attested platform_owner only). */
  readonly commercialRoles?: boolean;
  readonly onClose: () => void;
  readonly onSent: (email: string, role: string) => void;
}) {
  const roleId = useId();
  const hashId = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string>(SUPER_ADMIN);
  const [hash, setHash] = useState('');
  const role = commercialRoles ? picked : SUPER_ADMIN;
  const commercial = role !== SUPER_ADMIN;
  const hashValue = hash.trim();
  const hashOk = !commercial || isHumanRefHash(hashValue);
  const matches = typedConfirmMatches(typed, email);

  const commit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await adminsApi.invitePlatformAdmin({
        email,
        ...(displayName !== '' ? { display_name: displayName } : {}),
        ...(commercial ? { role_keys: [role], human_ref_hash: hashValue } : {}),
      });
      onSent(email, role);
    } catch (e) {
      setError(adminInviteErrorText(e));
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Invite platform admin"
      consequence={
        commercial
          ? `${ROLE_CONSEQUENCE[role] ?? roleLabel(role)} You are recorded as the person who attests their identity.`
          : ROLE_CONSEQUENCE[SUPER_ADMIN]
      }
      error={error}
      commitLabel="Send admin invitation"
      tone="privileged"
      canCommit={matches && hashOk}
      busy={busy}
      onCommit={() => void commit()}
    >
      {commercialRoles ? (
        <div className="pw-field">
          <label className="pw-field__label" htmlFor={roleId}>
            Role
          </label>
          <Select
            id={roleId}
            unstyled
            className="pw-select"
            value={picked}
            onChange={(e) => {
              setPicked(e.target.value);
              setError(null);
            }}
          >
            <option value={SUPER_ADMIN}>{roleLabel(SUPER_ADMIN)}</option>
            {COMMERCIAL_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {commercial ? (
        <div className="pw-field">
          <label className="pw-field__label" htmlFor={hashId}>
            Identity reference hash
          </label>
          <Input
            id={hashId}
            unstyled
            className="pw-input pw-mono"
            value={hash}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={(hashValue !== '' && !hashOk) || undefined}
            aria-describedby={`${hashId}-hint`}
            onChange={(e) => setHash(e.target.value)}
          />
          <span id={`${hashId}-hint`} className="pw-field__helper" aria-live="polite">
            {hashValue !== '' && !hashOk ? '64 lowercase hex characters (SHA-256). ' : ''}
            {HUMAN_REF_HINT}
          </span>
        </div>
      ) : null}
      <div className="pw-field">
        <TypedConfirm
          label="Type the email to confirm"
          expected={email}
          value={typed}
          onChange={setTyped}
        />
        <span className="pw-field__helper">Type {email} exactly.</span>
      </div>
    </ConfirmDialog>
  );
}
