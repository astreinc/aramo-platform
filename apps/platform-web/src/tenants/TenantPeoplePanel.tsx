import { useState } from 'react';
import { Button } from '@aramo/fe-foundation';

import { FieldText } from '../components';
import { platformApi } from '../platform-api';

import { EMAIL_PATTERN, inviteErrorCopy, type ErrorCopy } from './tenant-errors';
import { DEFAULT_INVITE_ROLES, TENANT_INVITE_ROLES } from './tenant-roles';

// PLATFORM-UX-1 F-5 (handoff §6.3 People; amendment 4; directive R-13) — invite
// a user into the tenant (POST /platform/tenants/:id/invitations, needs
// platform:tenant:provision). Role chips are toggle buttons (aria-pressed, ✓);
// Owner is disabled with the design note. Errors: INVITATION_ALREADY_EXISTS,
// EMAIL_UNAVAILABLE, VALIDATION_ERROR (the server message, which carries refused
// role combinations). The members list has no read endpoint: the designed empty
// card renders in its place.

export function TenantPeoplePanel({
  tenantId,
  host,
  canInvite,
}: {
  readonly tenantId: string;
  /** "slug.aramo.ai", or the console host when the tenant has no slug. */
  readonly host: string;
  readonly canInvite: boolean;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<readonly string[]>(DEFAULT_INVITE_ROLES);
  const [error, setError] = useState<ErrorCopy | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (key: string): void => {
    setRoles((r) => (r.includes(key) ? r.filter((k) => k !== key) : [...r, key]));
    setError(null);
    setOk(null);
  };

  const submit = async (): Promise<void> => {
    const e = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(e)) {
      setError({ code: 'VALIDATION', message: 'Enter a valid email address.' });
      return;
    }
    if (roles.length === 0) {
      setError({ code: 'VALIDATION', message: 'Choose at least one role.' });
      return;
    }
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await platformApi.inviteTenantUser(tenantId, {
        email: e,
        role_keys: [...roles],
        ...(name.trim() ? { display_name: name.trim() } : {}),
      });
      setEmail('');
      setName('');
      setRoles(DEFAULT_INVITE_ROLES);
      setOk(`Invitation sent to ${e}.`);
    } catch (err) {
      setError(inviteErrorCopy(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-people">
      <section className="pt-card pt-pad20">
        <h2 className="pt-people__title">Invite a user into this tenant</h2>
        <p className="pt-people__sub">They get an email invitation to {host}.</p>
        {canInvite ? (
          <>
            {error ? (
              <div role="alert" className="pw-alert pw-alert--error pt-people__alert">
                {error.message} <span className="pt-err-code pt-err-code--plain">{error.code}</span>
              </div>
            ) : null}
            {ok ? (
              <div role="status" className="pw-alert pw-alert--success pt-people__alert">
                {ok}
              </div>
            ) : null}
            <div className="pt-grid14">
              <FieldText
                label="Email"
                type="email"
                value={email}
                onChange={(v) => {
                  setEmail(v);
                  setError(null);
                  setOk(null);
                }}
              />
              <FieldText
                label={
                  <>
                    Display name <span className="pt-label__opt">(optional)</span>
                  </>
                }
                value={name}
                onChange={setName}
              />
              <div className="pt-label">
                <span className="pt-label__text" id="pt-roles-label">
                  Roles
                </span>
                <div role="group" aria-labelledby="pt-roles-label" className="pt-chips">
                  {TENANT_INVITE_ROLES.map((r) => {
                    const on = roles.includes(r.key);
                    return (
                      <Button
                        key={r.key}
                        unstyled
                        className={on ? 'pt-chip pt-chip--on' : 'pt-chip'}
                        aria-pressed={on}
                        disabled={r.disabled}
                        title={r.disabled ? r.note : r.label}
                        onClick={() => toggle(r.key)}
                      >
                        {on ? '✓ ' : ''}
                        {r.label}
                      </Button>
                    );
                  })}
                </div>
                <span className="pt-chips__note">Owner can only be granted by an existing owner of this tenant.</span>
              </div>
            </div>
            <div className="pt-actions-end pt-actions-end--18">
              <Button
                unstyled
                className="pw-btn pw-btn--normal"
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => void submit()}
              >
                Send invitation
              </Button>
            </div>
          </>
        ) : (
          <div className="pt-note pt-note--flush" role="note">
            You can view this tenant. Inviting users needs the <b>Provision tenants</b> permission.
          </div>
        )}
      </section>
      <section className="pt-card pt-center pt-center--people">
        <b>Members</b>
        <p className="pt-center__text pt-center__text--10">Listing a tenant’s existing members isn’t available yet.</p>
      </section>
    </div>
  );
}
