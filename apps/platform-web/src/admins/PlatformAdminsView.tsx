import { useId, useState } from 'react';
import { Button, Input, hasScope, useOptionalToast, type Session } from '@aramo/fe-foundation';

import { ConfirmDialog, TypedConfirm, typedConfirmMatches } from '../components';
import { CommercialRolesSection } from '../commercial-governance/CommercialRolesSection';

import { STAFF_EMAIL_HINT, adminInviteErrorText, adminsApi, isStaffEmail } from './admins-api';
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

export function PlatformAdminsView({ session }: { readonly session?: Session } = {}) {
  if (session !== undefined && hasScope(session, 'platform:approval:read')) {
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
        <CommercialRolesSection session={session} />
        {hasScope(session, 'platform:admin:invite') ? (
          <div className="pw-ad-grid pw-gov-gap-top">
            <InviteAdminCard />
          </div>
        ) : null}
      </div>
    );
  }
  return <LegacyPlatformAdminsView />;
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

function InviteAdminCard() {
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
        <p className="pw-ad-card__sub">
          The invitee joins the Aramo Platform tenant as <b>Super admin</b> — the highest privilege
          on the platform.
        </p>
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
          onClose={() => setReviewing(null)}
          onSent={(sent) => {
            setReviewing(null);
            setEmail('');
            setName('');
            setDone(sent);
            toast.show(`Platform admin invitation sent to ${sent}.`);
          }}
        />
      ) : null}
    </>
  );
}

export function InviteAdminDialog({
  email,
  displayName,
  onClose,
  onSent,
}: {
  readonly email: string;
  readonly displayName: string;
  readonly onClose: () => void;
  readonly onSent: (email: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typedConfirmMatches(typed, email);

  const commit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await adminsApi.invitePlatformAdmin({
        email,
        ...(displayName !== '' ? { display_name: displayName } : {}),
      });
      onSent(email);
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
      consequence="This person joins the Aramo Platform tenant as Super admin, with all 10 platform permissions: they can provision, suspend and close any tenant."
      error={error}
      commitLabel="Send admin invitation"
      tone="privileged"
      canCommit={matches}
      busy={busy}
      onCommit={() => void commit()}
    >
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
