import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '@aramo/fe-foundation';

import { domainApi, type DomainApi, type DomainDelegation, type DomainStatus, type DomainView } from '../domain-api';
import { Btn, ErrorBox, Field, Loading, TextIn, fmtDate } from '../ui';

// Domain-Enforcement P3 (LOCKED) §4/§5 — the "Domain" card. Shown in Settings →
// Domain and on the first-time owner's "Set up Aramo Sign" page (where checkout
// is refused until the domain is verified). The backend decides everything; the
// card shows the status, the DNS record to publish, "Check now", and lets the
// owner assign the work to an IT administrator (a 7-day link; list + revoke).

const STATUS_TAG: Record<DomainStatus, [string, string]> = {
  UNVERIFIED: ['Unverified', 'grey'],
  PENDING: ['Pending', 'warn'],
  VERIFIED: ['Verified', 'ok'],
};

export const CONFLICT_MESSAGE = 'Another Aramo organization holds this domain. Contact Aramo support.';

function messageFor(e: unknown): string {
  if (e instanceof ApiError) {
    const reason = typeof e.details?.['reason'] === 'string' ? (e.details['reason'] as string) : '';
    if (e.status === 403) return 'Only an organization owner or admin can verify the domain.';
    if (reason === 'no_allowed_domain') return 'Your organization has no email domain to verify.';
    if (reason === 'already_verified') return 'This domain is already verified.';
    if (reason === 'invalid_delegate_email') return 'Enter a valid email address.';
    if (reason === 'too_many_active_delegations') return 'Too many verification links are active. Revoke one first.';
    if (reason === 'no_token_issued') return 'Get the DNS record first.';
  }
  return 'Something went wrong. Try again.';
}

export function DomainCard({ api = domainApi }: { api?: DomainApi }) {
  const [view, setView] = useState<DomainView | null>(null);
  const [delegations, setDelegations] = useState<DomainDelegation[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');

  const loadDelegations = useCallback(() => {
    api
      .delegations()
      .then((r) => setDelegations(r.items))
      .catch(() => setDelegations([]));
  }, [api]);

  useEffect(() => {
    let live = true;
    api
      .status()
      .then((v) => {
        if (!live) return;
        setView(v);
        if (v.status !== 'VERIFIED') loadDelegations();
      })
      .catch((e: unknown) => live && setLoadError(messageFor(e)));
    return () => {
      live = false;
    };
  }, [api, loadDelegations]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  const onRequest = () =>
    run(async () => {
      setView(await api.request());
    });

  const onCheck = () =>
    run(async () => {
      const v = await api.check();
      setView(v);
      if (v.status !== 'VERIFIED') setNotice('No matching record yet. DNS changes can take minutes to hours to appear; try again later.');
      else setDelegations([]);
    });

  const onDelegate = (ev: FormEvent) => {
    ev.preventDefault();
    void run(async () => {
      const d = await api.delegate(email.trim());
      setEmail('');
      setNotice(`We emailed ${d.delegate_email} a link to publish the DNS record.`);
      loadDelegations();
    });
  };

  const onRevoke = (d: DomainDelegation) =>
    run(async () => {
      await api.revoke(d.id);
      setDelegations((cur) => cur.filter((x) => x.id !== d.id));
    });

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setNotice('Copied'),
      () => setError('Could not copy to the clipboard.'),
    );
  };

  if (loadError !== null)
    return (
      <section className="sg-card" data-testid="domain-card">
        <div className="sg-card__head">Domain</div>
        <div className="sg-card__body">
          <ErrorBox>{loadError}</ErrorBox>
        </div>
      </section>
    );
  if (view === null)
    return (
      <section className="sg-card" data-testid="domain-card">
        <div className="sg-card__head">Domain</div>
        <Loading label="Loading domain verification…" />
      </section>
    );

  const domain = view.allowed_domain ?? 'your domain';
  const [label, tone] = STATUS_TAG[view.status];
  const authoritative = view.domain_claim === 'AUTHORITATIVE';
  const conflict = view.domain_claim_conflict === true;
  const verifiedPendingClaim = view.status === 'VERIFIED' && !authoritative && !conflict;
  const showRecord = view.status === 'PENDING' && view.record_name !== null && view.record_value !== null;

  return (
    <section className="sg-card" data-testid="domain-card">
      <div className="sg-card__head">
        Domain
        <span className={`sg-card__end sg-tag sg-tag--${tone}`} data-testid="domain-status">
          {label}
        </span>
      </div>
      <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
        <p className="sg-help" style={{ margin: 0 }}>
          Verify your domain to make your organization the owner of <strong>{domain}</strong> on Aramo and to start sending with a paid plan.
        </p>
        {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
        {notice !== null ? (
          <div className="sg-note" data-testid="domain-notice">
            {notice}
          </div>
        ) : null}

        {view.status === 'VERIFIED' && authoritative ? (
          <div className="sg-note" data-testid="domain-authoritative">
            Your organization is the verified owner of {domain} on Aramo{view.verified_at !== null ? ` (verified ${fmtDate(view.verified_at)})` : ''}.
          </div>
        ) : null}
        {conflict ? (
          <ErrorBox>
            <span data-testid="domain-conflict">{CONFLICT_MESSAGE}</span>
          </ErrorBox>
        ) : null}
        {verifiedPendingClaim ? (
          <div className="sg-note" data-testid="domain-claim-pending">
            The domain is verified. Select Check now to finish confirming your organization as its owner.
          </div>
        ) : null}

        {showRecord ? (
          <div className="sg-grid" style={{ gap: 8 }} data-testid="domain-record">
            <div className="sg-muted">Add this TXT record at the DNS provider for {domain}, then select Check now:</div>
            <div className="sg-kv">
              <div>
                <div className="sg-kv__k">Name</div>
                <div className="sg-kv__v" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <code data-testid="domain-record-name" style={{ wordBreak: 'break-all' }}>
                    {view.record_name}
                  </code>
                  <Btn size="sm" type="button" onClick={() => copy(view.record_name as string)}>
                    Copy
                  </Btn>
                </div>
              </div>
              <div>
                <div className="sg-kv__k">Value (TXT)</div>
                <div className="sg-kv__v" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <code data-testid="domain-record-value" style={{ wordBreak: 'break-all' }}>
                    {view.record_value}
                  </code>
                  <Btn size="sm" type="button" onClick={() => copy(view.record_value as string)}>
                    Copy
                  </Btn>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {view.status === 'UNVERIFIED' && view.allowed_domain !== null ? (
            <Btn variant="primary" type="button" disabled={busy} onClick={() => void onRequest()} data-testid="domain-request">
              Get the DNS record
            </Btn>
          ) : null}
          {view.status === 'PENDING' || verifiedPendingClaim ? (
            <Btn variant="primary" type="button" disabled={busy} onClick={() => void onCheck()} data-testid="domain-check">
              {busy ? 'Checking…' : 'Check now'}
            </Btn>
          ) : null}
        </div>

        {view.status !== 'VERIFIED' && view.allowed_domain !== null ? (
          <div className="sg-grid" style={{ gap: 8 }} data-testid="domain-delegation">
            {delegations.map((d) => (
              <div key={d.id} className="sg-note" data-testid="domain-delegation-row">
                <span>
                  Domain verification pending — assigned to <strong>{d.delegate_email}</strong> (link valid until {fmtDate(d.expires_at)}).
                </span>
                <Btn size="sm" type="button" disabled={busy} onClick={() => void onRevoke(d)} data-testid={`domain-revoke-${d.id}`}>
                  Revoke
                </Btn>
              </div>
            ))}
            <form onSubmit={onDelegate} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="Don’t manage DNS? Assign it to your IT administrator" htmlFor="domain-delegate-email">
                <TextIn
                  id="domain-delegate-email"
                  type="email"
                  placeholder="it-admin@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </Field>
              <Btn type="submit" disabled={busy || email.trim() === ''} data-testid="domain-delegate">
                Assign to my IT administrator
              </Btn>
            </form>
            <p className="sg-help" style={{ margin: 0 }}>
              They get an email with the DNS record and a Check button, valid for 7 days. It gives them no other access to Aramo.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
