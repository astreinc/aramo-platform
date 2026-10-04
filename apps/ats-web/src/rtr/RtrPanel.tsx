import { Button } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';

import {
  requestRtr,
  sendRtr,
  getCurrentRtr,
  getRtrPreview,
  type RtrCurrentResponse,
} from './rtr-api';

// RTR-TEMPLATE-1 (§19, §20) — the recruiter-facing RTR cell in the Talent-journey
// grid. RTR is template-driven and backend-authoritative: this panel only presents
// the derived status + pinned-template provenance and offers the locked actions
// (Request → Preview → Send → Refresh; executed evidence links). It NEVER chooses a
// template, edits content, or exposes Copy-link / Resend / Void. On mount it
// reconciles the authoritative current RTR so a reload never reverts an existing
// RTR back to "Request RTR".

const STATUS_LABEL: Record<string, string> = {
  REQUESTED: 'Requested',
  AWAITING_SIGNATURE: 'Awaiting signature',
  EXECUTED: 'Executed',
};

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface RtrPanelProps {
  talentId: string;
  requisitionId: string;
  companyId: string;
  // Suppress the panel's own heading when the host surface already labels it
  // (e.g. the Talent-journey "Right to represent" column header).
  hideHeading?: boolean;
  // Least-visibility action gating (§21). Backend remains authoritative regardless;
  // these only hide controls the actor could never use.
  canRead: boolean; // document:read — see status / provenance / preview / evidence
  canRequest: boolean; // document:create — Request RTR
  canSend: boolean; // document:execute — Send for signature
}

export function RtrPanel({
  talentId,
  requisitionId,
  companyId,
  hideHeading = false,
  canRead,
  canRequest,
  canSend,
}: RtrPanelProps): JSX.Element {
  const [current, setCurrent] = useState<RtrCurrentResponse | null>(null);
  const [loading, setLoading] = useState(canRead);
  const [busy, setBusy] = useState<'' | 'requesting' | 'sending' | 'refreshing' | 'previewing'>('');
  const [error, setError] = useState<string>('');

  const reconcile = useCallback(async (): Promise<void> => {
    const cur = await getCurrentRtr(talentId, requisitionId);
    setCurrent(cur);
  }, [talentId, requisitionId]);

  // Mount reconciliation (§19) — restore the authoritative current RTR. Skipped
  // without document:read (the panel shows nothing actionable in that case).
  useEffect(() => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    (async () => {
      try {
        const cur = await getCurrentRtr(talentId, requisitionId);
        if (active) setCurrent(cur);
      } catch (e) {
        if (active) setError(messageOf(e));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [talentId, requisitionId, canRead]);

  const run = async (phase: typeof busy, fn: () => Promise<void>): Promise<void> => {
    setBusy(phase);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy('');
    }
  };

  const onRequest = (): Promise<void> =>
    run('requesting', async () => {
      await requestRtr({ talent_id: talentId, requisition_id: requisitionId, company_id: companyId });
      await reconcile();
    });

  const onSend = (): Promise<void> =>
    run('sending', async () => {
      if (current === null) return;
      await sendRtr(current.document_id, talentId);
      await reconcile();
    });

  const onRefresh = (): Promise<void> => run('refreshing', reconcile);

  const onPreview = (): Promise<void> =>
    run('previewing', async () => {
      if (current === null) return;
      const res = await getRtrPreview(current.document_id);
      window.open(res.url, '_blank', 'noopener');
    });

  const provenance =
    current?.template != null ? (
      <span className="rc-tj__rtr-prov" title="Generated from your organization's active RTR template">
        {current.template.name} · v{current.template.version_number}
      </span>
    ) : null;

  const errorBlock =
    error.length > 0 ? (
      <div className="rc-tj__rtr-error" role="alert">
        <span>{error}</span>
        {canRead ? (
          <Button unstyled type="button" className="rc-tj__rtrlink" onClick={() => void onRefresh()}>
            Try again
          </Button>
        ) : null}
      </div>
    ) : null;

  // Body — one compact vertical stack across all states.
  let body: JSX.Element;
  if (!canRead) {
    body = <span className="rc-tj__rtr-muted">—</span>;
  } else if (loading) {
    body = <span className="rc-tj__rtr-muted">Loading…</span>;
  } else if (current === null) {
    body = canRequest ? (
      <Button unstyled type="button" className="rc-tj__rtrbtn" onClick={() => void onRequest()} disabled={busy !== ''}>
        {busy === 'requesting' ? 'Requesting…' : 'Request RTR'}
      </Button>
    ) : (
      <span className="rc-tj__rtr-muted">—</span>
    );
  } else {
    const label = STATUS_LABEL[current.status] ?? current.status;
    const executed = current.status === 'EXECUTED';
    const awaiting = current.status === 'AWAITING_SIGNATURE';
    const requested = current.status === 'REQUESTED';
    body = (
      <div className="rc-tj__rtr-stack">
        <span className={`rc-tj__rtr-status rc-tj__rtr-status--${current.status.toLowerCase()}`}>{label}</span>
        {provenance}
        <div className="rc-tj__rtr-actions">
          {requested && current.preview_available ? (
            <Button unstyled type="button" className="rc-tj__rtrlink" onClick={() => void onPreview()} disabled={busy !== ''}>
              {busy === 'previewing' ? 'Opening…' : 'Preview RTR'}
            </Button>
          ) : null}
          {requested && canSend ? (
            <Button unstyled type="button" className="rc-tj__rtrbtn" onClick={() => void onSend()} disabled={busy !== ''}>
              {busy === 'sending' ? 'Sending…' : 'Send for signature'}
            </Button>
          ) : null}
          {(requested || awaiting) ? (
            <Button unstyled type="button" className="rc-tj__rtrlink" onClick={() => void onRefresh()} disabled={busy !== ''}>
              Refresh status
            </Button>
          ) : null}
          {executed && current.executed_available ? (
            <a
              className="rc-tj__rtrlink"
              href={`/v1/documents/${current.document_id}/artifacts?role=EXECUTED`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View RTR
            </a>
          ) : null}
          {executed && current.certificate_available ? (
            <a
              className="rc-tj__rtrlink"
              href={`/v1/documents/${current.document_id}/artifacts?role=EXECUTION_CERTIFICATE`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Certificate
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <section className="rc-tj__rtr-panel" aria-label="Right to Represent">
      {!hideHeading ? <h3>Right to Represent</h3> : null}
      {body}
      {errorBlock}
    </section>
  );
}
