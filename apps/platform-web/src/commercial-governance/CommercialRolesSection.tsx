import { useCallback, useEffect, useState } from 'react';
import { Button, useOptionalToast } from '@aramo/fe-foundation';
import type { Session } from '@aramo/fe-foundation';

import { SkeletonPanel } from '../components';
import { GovernanceRequestDialog } from '../components/GovernanceRequestDialog';

import { governanceApi, idempotencyKey, type Roster, type RosterOperator } from './governance-api';
import {
  CHAIN_LABEL,
  COMMERCIAL_ROLES,
  PRIVILEGED_ROLES,
  chainLine,
  chainWhy,
  initialsOf,
  personName,
  planRoleChange,
  roleLabel,
  rolesText,
  shortRequestId,
} from './governance-model';
import { governanceErrorText } from './governance-errors';
import './governance.css';

// CCP-B5 (handoff §5.8, §3.2, §3.3) — Platform admins › commercial roles: the approval-chain
// panel (fulfillability from the LIVE roster, the same rule as the approve gate) and the
// roster with role chips and notes. "Request role change…" (platform_owner only) opens the
// role-change dialog, which creates one governed ROLE_GRANT / ROLE_REVOKE change request per
// toggled role (A9) — never a direct grant (PBD §5.3 B5). Removing Platform owner from the
// last owner is refused in the dialog (commit disabled) and by the server (409
// PLATFORM_LAST_OWNER), whose refusal is shown if it arrives.

/** The ACTIVE policy as the chain preview names it ("v1", "72 h"). */
interface ActivePolicyRef {
  readonly version: string;
  readonly ttl: string;
}

export function CommercialRolesSection({ session }: { readonly session: Session }) {
  const toast = useOptionalToast();
  const [roster, setRoster] = useState<Roster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState<RosterOperator | null>(null);
  const [policy, setPolicy] = useState<ActivePolicyRef | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setRoster(await governanceApi.listOperators());
      setError(null);
    } catch (e) {
      setError(governanceErrorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    governanceApi.listPolicyVersions().then(
      (l) => {
        const a = l.versions.find((v) => v.status === 'ACTIVE');
        setPolicy(
          a === undefined
            ? null
            : {
                version: `v${a.version_number}`,
                ttl: `${a.content?.approval_expiry_hours ?? '?'} h`,
              },
        );
      },
      () => setPolicy(null),
    );
  }, [load]);

  const me = roster?.operators.find((o) => o.user_id === session.sub);
  const isOwner =
    me !== undefined && me.attested && me.commercial_role_keys.includes('platform_owner');
  const people = (roster?.operators ?? []).filter(
    (o) => o.commercial_role_keys.length > 0 || o.role_keys.includes('super_admin'),
  );

  return (
    <>
      {roster !== null && !isOwner ? (
        <div className="pw-gov-note" role="note">
          <b>View only.</b> You can view commercial roles. Requesting a role change needs the{' '}
          <b>Platform owner</b> role.
        </div>
      ) : null}
      {error !== null ? (
        <div role="alert" className="pw-alert pw-alert--error pw-gov-gap">
          {error}
        </div>
      ) : null}
      <section className="pw-gov-card pw-gov-gap" aria-labelledby="pw-roles-chains">
        <div className="pw-gov-card__head">
          <h2 id="pw-roles-chains" className="pw-gov-card__title">
            Approval chains
          </h2>
          <p className="pw-gov-card__sub">
            A chain is fulfillable when one person can make the request and different people hold
            each step&apos;s role.
          </p>
        </div>
        <div className="pw-roles-chains">
          {(roster?.chains ?? []).map((c) => (
            <div key={c.key} className="pw-roles-chain">
              <div className="pw-roles-chain__head">
                <b className="pw-roles-chain__label">{CHAIN_LABEL[c.key]}</b>
                <span
                  className={
                    c.fulfillable
                      ? 'pw-roles-pill pw-roles-pill--ok'
                      : 'pw-roles-pill pw-roles-pill--warn'
                  }
                >
                  <span aria-hidden="true">{c.fulfillable ? '✓' : '✕'}</span>
                  <span>{c.fulfillable ? 'Fulfillable' : 'Not fulfillable'}</span>
                </span>
              </div>
              <div className="pw-roles-chain__steps">{chainLine(c)}</div>
              <div className="pw-roles-chain__why">{chainWhy(c)}</div>
            </div>
          ))}
        </div>
      </section>
      <section className="pw-gov-card" aria-label="Commercial roles">
        {roster === null && error === null ? (
          <SkeletonPanel lines={['60%', '80%']} label="Loading commercial roles…" />
        ) : null}
        {roster !== null && people.length > 0 ? (
          <div className="pw-gov-scroll">
            <table className="pw-gov-table pw-roles-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Commercial roles</th>
                  <th>Notes</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {people.map((o) => {
                  const name = personName(o, o.user_id);
                  const sa = o.commercial_role_keys.length === 0;
                  const pending = o.pending_role_requests[0];
                  const note = o.is_last_owner
                    ? 'Last Platform owner — removing this role is refused.'
                    : o.commercial_role_keys.length > 1
                      ? 'Holds two roles. Can still sign only one step per request.'
                      : pending !== undefined
                        ? `Pending ${shortRequestId(pending.id)}: ${pending.action_type === 'ROLE_GRANT' ? 'Grant' : 'Remove'} ${roleLabel(pending.role_key)}`
                        : !o.attested && !sa
                          ? 'No one-account-per-human attestation: can’t sign approval steps.'
                          : '';
                  return (
                    <tr key={o.user_id}>
                      <td>
                        <div className="pw-roles-person">
                          <span className="pw-roles-avatar" aria-hidden="true">
                            {initialsOf(name)}
                          </span>
                          <span>
                            <span className="pw-roles-name">{name}</span>
                            <span className="pw-roles-email">{o.email ?? o.user_id}</span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="pw-roles-chips">
                          {sa ? (
                            <span className="pw-roles-chip pw-roles-chip--sa">
                              Super admin · no commercial roles
                            </span>
                          ) : (
                            o.commercial_role_keys.map((r) => (
                              <span
                                key={r}
                                className={
                                  PRIVILEGED_ROLES.includes(r)
                                    ? 'pw-roles-chip pw-roles-chip--priv'
                                    : 'pw-roles-chip'
                                }
                              >
                                {roleLabel(r)}
                              </span>
                            ))
                          )}
                        </div>
                      </td>
                      <td
                        className={
                          o.is_last_owner ? 'pw-roles-note pw-roles-note--warn' : 'pw-roles-note'
                        }
                      >
                        {note}
                      </td>
                      <td className="pw-roles-act">
                        {isOwner && !sa ? (
                          <Button
                            unstyled
                            className="pw-gov-btn pw-gov-btn--32 pw-gov-btn--secondary"
                            onClick={() => setSubject(o)}
                          >
                            Request role change…
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {roster !== null && people.length === 0 ? (
          <div className="pw-gov-empty">
            <b>No platform admins hold commercial roles</b>
            <div className="pw-gov-empty__body">
              Every commercial chain is unfulfillable until roles are granted.
            </div>
          </div>
        ) : null}
      </section>
      {subject !== null && roster !== null ? (
        <RoleChangeDialog
          subject={subject}
          roster={roster}
          policy={policy}
          onClose={() => setSubject(null)}
          onDone={(ids) => {
            setSubject(null);
            toast.show(
              `${ids.map(shortRequestId).join(', ')} submitted · a different Platform owner approves`,
            );
            void load();
          }}
        />
      ) : null}
    </>
  );
}

export function RoleChangeDialog({
  subject,
  roster,
  policy,
  onClose,
  onDone,
}: {
  readonly subject: RosterOperator;
  readonly roster: Roster;
  readonly policy: ActivePolicyRef | null;
  readonly onClose: () => void;
  readonly onDone: (requestIds: string[]) => void;
}) {
  const name = personName(subject, subject.user_id);
  const [roles, setRoles] = useState<string[]>([...subject.commercial_role_keys]);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = planRoleChange(subject, name, roles);
  const changed = plan.grants.length + plan.revokes.length > 0;
  const chain = roster.chains.find((c) => c.key === 'ROLE_CHANGE');
  const toggle = (r: string): void =>
    setRoles((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));

  const commit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const text = `${reason.trim()}\n\nEvidence: ${evidence.trim()}`;
    const ids: string[] = [];
    try {
      // One governed request per toggled role (A9); grants first, so an owner hand-over never
      // dips the platform to zero owners mid-way.
      for (const role_key of plan.grants) {
        ids.push(
          (
            await governanceApi.requestChange({
              action_type: 'ROLE_GRANT',
              payload: { subject_user_id: subject.user_id, role_key },
              reason: text,
              idempotency_key: idempotencyKey('role-grant'),
            })
          ).id,
        );
      }
      for (const role_key of plan.revokes) {
        ids.push(
          (
            await governanceApi.requestChange({
              action_type: 'ROLE_REVOKE',
              payload: { subject_user_id: subject.user_id, role_key },
              reason: text,
              idempotency_key: idempotencyKey('role-revoke'),
            })
          ).id,
        );
      }
      onDone(ids);
    } catch (e) {
      setError(
        ids.length > 0
          ? `${governanceErrorText(e)} (${ids.map(shortRequestId).join(', ')} already submitted)`
          : governanceErrorText(e),
      );
      setBusy(false);
    }
  };

  return (
    <GovernanceRequestDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Request role change · ${name}`}
      sub="Role changes take effect after a different Platform owner approves. Granting Platform owner or Finance admin is privileged."
      reason={reason}
      onReason={setReason}
      evidence={evidence}
      onEvidence={setEvidence}
      diff={[
        [
          name,
          rolesText(subject.commercial_role_keys),
          rolesText(COMMERCIAL_ROLES.filter((r) => roles.includes(r))),
        ],
      ]}
      chain={
        chain === undefined
          ? null
          : {
              label: CHAIN_LABEL.ROLE_CHANGE,
              steps: 'Owner',
              policy: policy?.version ?? '—',
              ttl: policy?.ttl ?? '—',
              notFulfillable: !chain.fulfillable,
            }
      }
      alert={plan.refusal}
      error={error}
      commitLabel="Submit for approval"
      tone="privileged"
      canCommit={changed && reason.trim() !== '' && evidence.trim() !== ''}
      busy={busy}
      onCommit={() => void commit()}
    >
      <div className="pw-gd-field">
        <span className="pw-gd-field__label" id="pw-roles-toggle-label">
          Commercial roles
        </span>
        <div className="pw-gd-toggles" role="group" aria-labelledby="pw-roles-toggle-label">
          {COMMERCIAL_ROLES.map((r) => {
            const on = roles.includes(r);
            return (
              <Button
                key={r}
                unstyled
                className="pw-gd-toggle"
                aria-pressed={on}
                onClick={() => toggle(r)}
              >
                {on ? '✓' : '+'} {roleLabel(r)}
              </Button>
            );
          })}
        </div>
      </div>
    </GovernanceRequestDialog>
  );
}
