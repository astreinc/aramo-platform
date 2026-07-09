import { ApiError, useToast } from '@aramo/fe-foundation';
import { useEffect, useState } from 'react';
import { IconLock } from '@aramo/fe-foundation';

import { Button, Card, InlineAlert, StatusPill, type PillTone } from '../../ui';
import { SettingCardHead, SettingHint, SettingRow } from '../components';

import {
  checkDomainVerification,
  fetchDomainVerification,
  requestDomainVerification,
  type DomainVerificationStatus,
  type DomainVerificationView,
} from './domain-api';

// Domain-Enforcement P2b §7 — the tenant-admin domain-verification panel (in the
// Security & SSO settings group). Reuses the TenantProfileForm fetch→display→
// action template + StatusPill (DOMAIN_TONE) + a monospace TXT block with copy.
//
// INFORMATIONAL (PO ruling (a)): verifying gates nothing — it is a status the
// tenant can prove + display. The panel makes the proof self-serve: show the TXT
// record to publish, then a "Check DNS record" button that flips it to VERIFIED.

// §7 — displayed status → StatusPill tone (mirrors the invite-S3 STATUS_TONE).
const DOMAIN_TONE: Record<DomainVerificationStatus, PillTone> = {
  UNVERIFIED: 'neutral',
  PENDING: 'warn',
  VERIFIED: 'ok',
};
const DOMAIN_LABEL: Record<DomainVerificationStatus, string> = {
  UNVERIFIED: 'Not verified',
  PENDING: 'Pending DNS',
  VERIFIED: 'Verified',
};

interface Props {
  readonly fetchFn?: () => Promise<DomainVerificationView>;
  readonly requestFn?: () => Promise<DomainVerificationView>;
  readonly checkFn?: () => Promise<DomainVerificationView>;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; view: DomainVerificationView }
  | { status: 'error'; message: string };

function messageForError(err: unknown): string {
  if (err instanceof ApiError) {
    const reason =
      typeof err.details?.['reason'] === 'string'
        ? (err.details['reason'] as string)
        : '';
    if (reason === 'no_allowed_domain') {
      return 'This workspace has no locked domain yet, so there is nothing to verify.';
    }
    if (reason === 'no_token_issued') {
      return 'Request verification first to generate a DNS record to publish.';
    }
    return err.message || 'Something went wrong.';
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export function DomainVerificationPanel({ fetchFn, requestFn, checkFn }: Props = {}) {
  const load = fetchFn ?? fetchDomainVerification;
  const request = requestFn ?? requestDomainVerification;
  const check = checkFn ?? checkDomainVerification;
  const toast = useToast();

  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    let cancelled = false;
    load()
      .then((view) => {
        if (!cancelled) setState({ status: 'ready', view });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', message: messageForError(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const run = async (
    fn: () => Promise<DomainVerificationView>,
    after: (v: DomainVerificationView) => void,
  ) => {
    setBusy(true);
    setActionError('');
    try {
      const view = await fn();
      setState({ status: 'ready', view });
      after(view);
    } catch (err: unknown) {
      setActionError(messageForError(err));
    } finally {
      setBusy(false);
    }
  };

  const onRequest = () =>
    run(request, () => toast.show('Verification record generated — add it to your DNS'));

  const onCheck = () =>
    run(check, (v) => {
      if (v.status === 'VERIFIED') toast.show('Domain verified');
      else toast.show('No matching record yet — DNS may still be propagating');
    });

  const onCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show(`${label} copied`);
    } catch {
      setActionError('Could not copy to the clipboard.');
    }
  };

  if (state.status === 'loading') {
    return <p className="set-muted">Loading domain verification…</p>;
  }
  if (state.status === 'error') {
    return <InlineAlert variant="error">{state.message}</InlineAlert>;
  }

  const v = state.view;
  const hasDomain = v.allowed_domain !== null && v.allowed_domain.length > 0;

  return (
    <Card flush>
      <SettingCardHead
        icon={<IconLock />}
        title="Domain verification"
        sub="Prove your organization controls its domain by publishing a DNS TXT record."
      />
      <div className="rc-card--pad">
        {actionError ? <InlineAlert variant="error">{actionError}</InlineAlert> : null}

        <SettingRow
          title="Status"
          sub={
            hasDomain
              ? `Domain: ${v.allowed_domain}`
              : 'No locked domain on this workspace yet.'
          }
        >
          <StatusPill tone={DOMAIN_TONE[v.status]} dot>
            {DOMAIN_LABEL[v.status]}
          </StatusPill>
        </SettingRow>

        {v.status === 'VERIFIED' && v.verified_at !== null ? (
          <SettingRow
            title="Verified"
            sub={`On ${new Date(v.verified_at).toLocaleString()}`}
          />
        ) : null}

        {hasDomain && v.record_value !== null && v.record_name !== null ? (
          <>
            <p className="set-muted" style={{ paddingTop: 0 }}>
              Add this TXT record at your DNS provider, then click{' '}
              <strong>Check DNS record</strong>:
            </p>
            <div className="rc-fgrid">
              <label className="rc-ifield">
                <span>Record name</span>
                <div className="set-row__r" style={{ gap: 8, display: 'flex' }}>
                  <code data-testid="domain-record-name" style={{ wordBreak: 'break-all' }}>
                    {v.record_name}
                  </code>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onCopy(v.record_name as string, 'Record name')}
                    data-testid="domain-copy-name"
                  >
                    Copy
                  </Button>
                </div>
              </label>
              <label className="rc-ifield">
                <span>Record value (type TXT)</span>
                <div className="set-row__r" style={{ gap: 8, display: 'flex' }}>
                  <code data-testid="domain-record-value" style={{ wordBreak: 'break-all' }}>
                    {v.record_value}
                  </code>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onCopy(v.record_value as string, 'Record value')}
                    data-testid="domain-copy-value"
                  >
                    Copy
                  </Button>
                </div>
              </label>
            </div>
          </>
        ) : null}

        <div className="rc-formfoot">
          {hasDomain && v.status === 'UNVERIFIED' ? (
            <Button onClick={onRequest} disabled={busy} data-testid="domain-request">
              {busy ? 'Generating…' : 'Start verification'}
            </Button>
          ) : null}
          {hasDomain && v.status === 'PENDING' ? (
            <>
              <Button onClick={onCheck} disabled={busy} data-testid="domain-check">
                {busy ? 'Checking…' : 'Check DNS record'}
              </Button>
              <Button
                variant="secondary"
                onClick={onRequest}
                disabled={busy}
                data-testid="domain-reissue"
              >
                Re-issue token
              </Button>
            </>
          ) : null}
        </div>

        <SettingHint>
          DNS changes can take minutes to hours to propagate. If the check does not pass
          immediately, wait and try again — your status stays pending until the record is found.
        </SettingHint>
      </div>
    </Card>
  );
}
