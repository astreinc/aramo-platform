import { formatDate, useToast } from '@aramo/fe-foundation';
import { useEffect, useState } from 'react';

import { OrgPageHeader } from '../ui/OrgPage';

import {
  checkDomainVerification,
  fetchDomainVerification,
  requestDomainVerification,
  type DomainVerificationView,
} from './domain-api';
import { DomainDelegationPanel, RECORD_ROW } from './DomainDelegationPanel';
import {
  DOMAIN_CLAIM_LABEL,
  DOMAIN_CONFLICT_MESSAGE,
  DOMAIN_NOTE,
  DOMAIN_STATUS_PILL,
  domainErrorMessage,
} from './domain-messages';

// ORG-UX-1 (Directive v1.0 LOCKED §8.6, §13.4; handoff §6.6) — Domain, against the
// implemented Domain-Enforcement P3 services ONLY (no other verification mechanism):
//   GET  /v1/tenant/domain-verification         status + record + P3 claim
//   POST /v1/tenant/domain-verification         "Get TXT record" (mint the token)
//   POST /v1/tenant/domain-verification/check   "Check now"
//   delegations (issue / list / revoke)          DomainDelegationPanel (G16)
// The server writes every audit event. The SSO card is PLANNED (no controls).

const STEP = { fontSize: 13, fontWeight: 700, color: 'var(--ox-ink-2)' } as const;

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly view: DomainVerificationView }
  | { readonly status: 'error'; readonly message: string };

export function DomainPage() {
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [busy, setBusy] = useState<'none' | 'request' | 'check'>('none');
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    fetchDomainVerification()
      .then((view) => live && setLoad({ status: 'ready', view }))
      .catch((e: unknown) => live && setLoad({ status: 'error', message: domainErrorMessage(e) }));
    return () => {
      live = false;
    };
  }, []);

  const run = async (kind: 'request' | 'check', fn: () => Promise<DomainVerificationView>, after: (v: DomainVerificationView) => void) => {
    setBusy(kind);
    setError('');
    try {
      const view = await fn();
      setLoad({ status: 'ready', view });
      after(view);
    } catch (e: unknown) {
      setError(domainErrorMessage(e));
    } finally {
      setBusy('none');
    }
  };

  const onRequest = () => run('request', requestDomainVerification, () => toast.show('TXT record ready. Add it at your DNS provider.'));
  const onCheck = () =>
    run('check', checkDomainVerification, (v) => {
      if (v.status === 'VERIFIED') toast.show('Domain verified');
      else toast.show('No matching record yet. DNS changes can take minutes to hours to appear; try again later.');
    });

  const copy = (text: string, label: string) => {
    const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clip === undefined) {
      setError('Could not copy to the clipboard.');
      return;
    }
    void clip.writeText(text).then(
      () => toast.show(`${label} copied`),
      () => setError('Could not copy to the clipboard.'),
    );
  };

  return (
    <>
      <OrgPageHeader section="domain" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {load.status === 'error' ? (
          <div className="ox-alert ox-alert--error" role="alert">
            {load.message}
          </div>
        ) : load.status === 'loading' ? (
          <div className="ox-card" aria-busy="true" data-testid="domain-loading">
            <div className="ox-card__body ox-muted">Loading domain verification…</div>
          </div>
        ) : (
          <VerificationCard view={load.view} busy={busy} error={error} onRequest={() => void onRequest()} onCheck={() => void onCheck()} onCopy={copy} />
        )}
        <SsoPlannedCard />
      </div>
    </>
  );
}

function VerificationCard({
  view,
  busy,
  error,
  onRequest,
  onCheck,
  onCopy,
}: {
  readonly view: DomainVerificationView;
  readonly busy: 'none' | 'request' | 'check';
  readonly error: string;
  readonly onRequest: () => void;
  readonly onCheck: () => void;
  readonly onCopy: (text: string, label: string) => void;
}) {
  const hasDomain = view.allowed_domain !== null && view.allowed_domain.length > 0;
  const domain = hasDomain ? (view.allowed_domain as string) : 'your domain';
  const pill = DOMAIN_STATUS_PILL[view.status];
  const claim = view.domain_claim ?? null;
  const conflict = view.domain_claim_conflict === true;
  const verified = view.status === 'VERIFIED';
  const authoritative = claim === 'AUTHORITATIVE';
  // VERIFIED but the claim not yet promoted (and no conflict): one more Check finishes it.
  const verifiedPendingClaim = verified && !authoritative && !conflict;
  const hasRecord = view.record_name !== null && view.record_value !== null;
  const needsRecord = hasDomain && !verified && !hasRecord;
  const showSteps = hasDomain && !verified && hasRecord;

  return (
    <section className="ox-card" aria-labelledby="domain-verification-title" data-testid="domain-card">
      <div className="ox-card__head" style={{ flexWrap: 'wrap' }}>
        <div style={{ minWidth: 220 }}>
          <h2 id="domain-verification-title" className="ox-card__title">
            Domain verification
          </h2>
          <p className="ox-card__sub">
            Prove you control <b style={{ color: 'var(--ox-ink)', fontWeight: 600 }}>{domain}</b> by publishing a DNS TXT record.
          </p>
        </div>
        <span className={`ox-pill ${pill.className}`} style={{ flex: 'none', gap: 6, whiteSpace: 'nowrap' }} data-testid="domain-status">
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
          {pill.label}
        </span>
      </div>
      <div className="ox-card__body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error !== '' ? (
          <div className="ox-alert ox-alert--error" role="alert">
            {error}
          </div>
        ) : null}
        {!hasDomain ? <p className="ox-muted" style={{ margin: 0, fontSize: 13.5 }}>Your organization has no email domain to verify.</p> : null}

        {claim !== null ? (
          <div className="ox-row" style={{ fontSize: 13 }} data-testid="domain-claim">
            <span className="ox-muted">Ownership claim</span>
            <span className="ox-chip">{DOMAIN_CLAIM_LABEL[claim]}</span>
          </div>
        ) : null}
        {verified && authoritative ? (
          <div className="ox-alert ox-alert--info" data-testid="domain-authoritative">
            Your organization is the verified owner of {domain} on Aramo{view.verified_at !== null ? ` (verified ${formatDate(view.verified_at)})` : ''}.
          </div>
        ) : null}
        {claim === 'LAPSED' && !verified ? (
          <div className="ox-alert ox-alert--warn" data-testid="domain-claim-lapsed">
            Your organization’s reservation of {domain} lapsed. Verify the domain to claim it again.
          </div>
        ) : null}
        {claim === 'RELEASED' ? (
          <div className="ox-alert ox-alert--warn" data-testid="domain-claim-released">
            Your organization’s claim on {domain} was released.
          </div>
        ) : null}
        {conflict ? (
          <div className="ox-alert ox-alert--error" role="alert" data-testid="domain-conflict">
            {DOMAIN_CONFLICT_MESSAGE}
          </div>
        ) : null}
        {verifiedPendingClaim ? (
          <div className="ox-alert ox-alert--info" data-testid="domain-claim-pending">
            The domain is verified. Select Check now to finish confirming your organization as its owner.
          </div>
        ) : null}

        {needsRecord ? (
          <div className="ox-row" style={{ flexWrap: 'wrap', gap: 12 }}>
            <button type="button" className="ox-btn ox-btn--primary" disabled={busy !== 'none'} onClick={onRequest} data-testid="domain-request">
              {busy === 'request' ? 'Getting record…' : 'Get TXT record'}
            </button>
            <span className="ox-muted" style={{ fontSize: 12.5 }}>
              Aramo creates the TXT record you publish at your DNS provider.
            </span>
          </div>
        ) : null}

        {showSteps ? (
          <>
            <div style={STEP}>1 · Add this TXT record at your DNS provider</div>
            <RecordRow label="Name" value={view.record_name as string} testId="domain-record-name" onCopy={() => onCopy(view.record_name as string, 'Name')} />
            <RecordRow label="Value" value={view.record_value as string} testId="domain-record-value" onCopy={() => onCopy(view.record_value as string, 'Value')} />
          </>
        ) : null}

        {showSteps || verifiedPendingClaim ? (
          <>
            <div style={{ ...STEP, marginTop: 4 }}>{showSteps ? '2 · Check the record' : 'Check the record'}</div>
            <div className="ox-row" style={{ flexWrap: 'wrap', gap: 12 }}>
              <button type="button" className="ox-btn ox-btn--primary" disabled={busy !== 'none'} onClick={onCheck} data-testid="domain-check">
                {busy === 'check' ? 'Checking…' : 'Check now'}
              </button>
              <span className="ox-muted" style={{ fontSize: 12.5, flex: '1 1 240px', minWidth: 0 }} data-testid="domain-note">
                {DOMAIN_NOTE}
              </span>
            </div>
          </>
        ) : null}
        {needsRecord ? (
          <p className="ox-muted" style={{ margin: 0, fontSize: 12.5 }} data-testid="domain-note">
            {DOMAIN_NOTE}
          </p>
        ) : null}

        {hasDomain && !verified ? <DomainDelegationPanel domain={domain} /> : null}
      </div>
    </section>
  );
}

function RecordRow({ label, value, testId, onCopy }: { readonly label: string; readonly value: string; readonly testId: string; readonly onCopy: () => void }) {
  return (
    <div style={{ ...RECORD_ROW, display: 'grid', gridTemplateColumns: '90px minmax(0,1fr) auto', alignItems: 'center' }}>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--ox-faint)' }}>{label}</span>
      <code className="ox-mono" style={{ fontSize: 12.5, color: 'var(--ox-ink)', overflowWrap: 'anywhere' }} data-testid={testId}>
        {value}
      </code>
      <button type="button" className="ox-btn ox-btn--secondary ox-btn--sm" onClick={onCopy} aria-label={`Copy ${label.toLowerCase()}`}>
        Copy
      </button>
    </div>
  );
}

function SsoPlannedCard() {
  return (
    <section
      aria-labelledby="domain-sso-title"
      style={{ background: '#FAFBFC', border: '1px dashed #C6CDD4', borderRadius: 13, padding: '16px 20px' }}
      data-testid="domain-sso-planned"
    >
      <div className="ox-row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <h2 id="domain-sso-title" className="ox-card__title">
          Single sign-on &amp; sign-in policy
        </h2>
        <span className="ox-badge" style={{ color: 'var(--ox-muted)' }}>
          PLANNED
        </span>
      </div>
      <p style={{ fontSize: 13, color: 'var(--ox-muted)', margin: '6px 0 0', lineHeight: 1.55, maxWidth: 720 }}>
        People sign in through Aramo’s hosted login with their Microsoft or Google work account. Organization-level controls arrive later:
      </p>
      <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--ox-muted)', lineHeight: 1.8 }}>
        <li>Require single sign-on and multi-factor sign-in for everyone</li>
        <li>Session timeout and sign-out policy</li>
        <li>Allowed email domains for invitations</li>
      </ul>
    </section>
  );
}
