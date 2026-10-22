import { formatDate, useToast } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import {
  fetchDomainDelegations,
  issueDomainDelegation,
  revokeDomainDelegation,
  type DomainDelegation,
} from './domain-api';
import { domainErrorMessage } from './domain-messages';

// ORG-UX-1 (Directive v1.0 LOCKED §8.6, G16) — delegate the DNS work to an IT
// administrator: issue / list / revoke over the P3 routes
// (domain-verification.controller.ts GET/POST /delegations, DELETE /delegations/:id).
// The UX is ported from apps/sign-web's DomainCard (copied, not imported). The
// delegate gets an email with the record and a Check button, valid for 7 days; the
// backend audits issue / use / revoke.

export function DomainDelegationPanel({ domain }: { readonly domain: string }) {
  const toast = useToast();
  const [items, setItems] = useState<readonly DomainDelegation[]>([]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(() => {
    fetchDomainDelegations()
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const onIssue = async (ev: FormEvent) => {
    ev.preventDefault();
    const to = email.trim();
    if (to === '' || busy) return;
    setBusy(true);
    setError('');
    try {
      const d = await issueDomainDelegation(to);
      setEmail('');
      toast.show(`We emailed ${d.delegate_email} a link to publish the DNS record.`);
      reload();
    } catch (e: unknown) {
      setError(domainErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (d: DomainDelegation) => {
    setBusy(true);
    setError('');
    try {
      await revokeDomainDelegation(d.id);
      setItems((cur) => cur.filter((x) => x.id !== d.id));
      toast.show(`Revoked the link sent to ${d.delegate_email}`);
    } catch (e: unknown) {
      setError(domainErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="domain-delegation">
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ox-ink-2)', marginTop: 4 }}>Don’t manage DNS for {domain}?</div>
      {error !== '' ? (
        <div className="ox-alert ox-alert--error" role="alert">
          {error}
        </div>
      ) : null}
      {items.map((d) => (
        <div key={d.id} className="ox-row" style={RECORD_ROW} data-testid="domain-delegation-row">
          <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
            Assigned to <b style={{ fontWeight: 600 }}>{d.delegate_email}</b>
            <span className="ox-muted"> · link valid until {formatDate(d.expires_at)}</span>
          </span>
          <button type="button" className="ox-btn ox-btn--secondary ox-btn--sm" disabled={busy} onClick={() => void onRevoke(d)} data-testid={`domain-revoke-${d.id}`}>
            Revoke
          </button>
        </div>
      ))}
      <form onSubmit={(ev) => void onIssue(ev)} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="ox-field" style={{ flex: '1 1 260px', maxWidth: 360 }}>
          <span className="ox-label">IT administrator’s email</span>
          <input
            className="ox-input"
            type="email"
            placeholder="it-admin@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="domain-delegate-email"
          />
        </label>
        <button type="submit" className="ox-btn ox-btn--secondary" disabled={busy || email.trim() === ''} data-testid="domain-delegate">
          Assign to my IT administrator
        </button>
      </form>
      <p className="ox-hint" style={{ margin: 0 }}>
        They get an email with the DNS record and a Check button, valid for 7 days. It gives them no other access to Aramo.
      </p>
    </div>
  );
}

/** The #FAFBFC / 1px #E5E9ED / 9px radius row (handoff §6.6). */
export const RECORD_ROW = {
  background: '#FAFBFC',
  border: '1px solid var(--ox-line)',
  borderRadius: 9,
  padding: '9px 12px',
  gap: 12,
} as const;
