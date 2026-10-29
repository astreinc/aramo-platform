import { useMemo, useState } from 'react';
import { useToast } from '@aramo/fe-foundation';

import { OrgModal } from '../ui/OrgPage';

import { personName } from './directory';
import { ORG_ROLE_KEYS, roleWriteErrorMessage } from './role-groups';
import type { TenantUserView } from './types';
import { removeTenantUserSignAccess } from './users-api';

// Aramo-Sign-Mobile-Amendment-M-A8 §2.3 — "Remove Sign access" on Roles & access (the
// ruling's "Users & Product Access" surface; no rename). Organization administrators
// manage product access; Business users never delete their own organization-managed
// account. The action removes only the person's Aramo Sign roles and signs them out of
// Aramo Sign; everything else is kept. People who hold an organization role (Tenant
// Owner / Tenant Admin) have Aramo Sign through it and are not offered here.

export const REMOVE_SIGN_KEEPS =
  'Kept: their Aramo sign-in, their membership in your organization, their roles in other Aramo apps, and every envelope, agreement, certificate and signing history. Envelopes they sent stay with your organization; Sign administrators can still see and manage them.';
export const REMOVE_SIGN_REMOVES = 'Removed: their Aramo Sign roles. They are signed out of Aramo Sign on every browser and device.';

const isSignRole = (k: string): boolean => k.startsWith('sign_');

export function RemoveSignAccess({
  people,
  roleName,
  onRemoved,
}: {
  readonly people: readonly TenantUserView[];
  readonly roleName: (key: string) => string;
  readonly onRemoved: () => void;
}) {
  const toast = useToast();
  const eligible = useMemo(
    () => people.filter((u) => u.role_keys.some(isSignRole) && !u.role_keys.some((k) => ORG_ROLE_KEYS.includes(k))),
    [people],
  );
  const [pick, setPick] = useState('');
  const [confirming, setConfirming] = useState<TenantUserView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = eligible.find((u) => u.user_id === pick) ?? eligible[0];

  const confirm = async () => {
    if (confirming === null) return;
    setBusy(true);
    setError(null);
    try {
      await removeTenantUserSignAccess(confirming.user_id);
      toast.show(`${personName(confirming)} no longer has Aramo Sign access.`);
      setConfirming(null);
      setPick('');
      onRemoved();
    } catch (err: unknown) {
      setError(roleWriteErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ox-card" data-testid="remove-sign-access" aria-labelledby="remove-sign-access-title">
      <div className="ox-card__head">
        <div>
          <h2 id="remove-sign-access-title" className="ox-card__title">
            Remove Sign access
          </h2>
          <p className="ox-card__sub">
            Take Aramo Sign away from someone without removing them from your organization. To remove all access, disable the user in Users &amp; invitations.
          </p>
        </div>
      </div>
      <div className="ox-card__body">
        {eligible.length === 0 ? (
          <span className="oxp-count--none" style={{ fontSize: 12.5 }}>
            No one has an Aramo Sign role that can be removed here.
          </span>
        ) : (
          <div className="oxp-add">
            <select className="ox-select" aria-label="Person to remove from Aramo Sign" value={chosen?.user_id ?? ''} onChange={(e) => setPick(e.target.value)}>
              {eligible.map((u) => (
                <option key={u.user_id} value={u.user_id}>
                  {`${personName(u)} · ${u.email}`}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ox-btn ox-btn--secondary ox-btn--sm"
              disabled={busy || chosen === undefined}
              onClick={() => {
                setError(null);
                setConfirming(chosen ?? null);
              }}
              data-testid="remove-sign-access-open"
            >
              Remove Sign access
            </button>
          </div>
        )}
      </div>
      {confirming !== null ? (
        <OrgModal
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(null);
          }}
          testId="remove-sign-access-modal"
          title={`Remove Aramo Sign access for ${personName(confirming)}?`}
          subtitle={confirming.email}
          footer={
            <>
              <button type="button" className="ox-btn ox-btn--secondary" onClick={() => setConfirming(null)}>
                Cancel
              </button>
              <button type="button" className="ox-btn ox-btn--danger" disabled={busy} onClick={() => void confirm()} data-testid="remove-sign-access-confirm">
                Remove Sign access
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            {REMOVE_SIGN_REMOVES} ({confirming.role_keys.filter(isSignRole).map(roleName).join(', ')})
          </p>
          <p style={{ margin: 0 }}>{REMOVE_SIGN_KEEPS}</p>
          {error !== null ? (
            <div className="ox-alert ox-alert--error" role="alert">
              {error}
            </div>
          ) : null}
        </OrgModal>
      ) : null}
    </section>
  );
}
