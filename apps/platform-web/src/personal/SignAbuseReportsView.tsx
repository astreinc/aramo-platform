import { useCallback, useEffect, useState } from 'react';
import { Button, useOptionalToast } from '@aramo/fe-foundation';

import { ConfirmDialog, EmptyState, FieldTextArea, Pill, SkeletonPanel, formatDate } from '../components';
import { platformApi, type SignAbuseQueueItem } from '../platform-api';

import {
  REASON_MAX,
  REPORT_BUTTON,
  REPORT_DECISIONS,
  REPORT_PILL,
  loadErrorText,
  reportCategory,
  reportDecisionSpec,
  type ReportDecision,
} from './personal-review-model';
import './personal.css';

// Aramo-Sign-Mobile-Amendment-M-A7 §5.2 (R-11) — the operators' abuse-report queue
// across every Aramo Sign sender. Reports on a Business sender's emails land here
// (they never pause the organization automatically); Personal reports show too
// (their automatic pause rules are unchanged; restrict/reinstate stays in the
// Review queue). Gated on platform:tenant:lifecycle:manage (App.tsx), as the API is.

type Filter = 'OPEN' | 'ALL';

function senderLabel(r: SignAbuseQueueItem): string {
  const kind = r.sender_kind === 'BUSINESS' ? 'Business' : r.sender_kind === 'PERSONAL' ? 'Personal' : 'Unknown sender';
  return r.sender_name ? `${kind} · ${r.sender_name}` : kind;
}

export function SignAbuseReportsView() {
  const toast = useOptionalToast();
  const [filter, setFilter] = useState<Filter>('OPEN');
  const [items, setItems] = useState<SignAbuseQueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ report: SignAbuseQueueItem; outcome: ReportDecision } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems((await platformApi.listSignAbuseReports(filter === 'OPEN' ? 'OPEN' : undefined)).items);
    } catch (e) {
      setError(loadErrorText(e, 'Reports couldn’t be loaded. Try again.'));
    }
  }, [filter]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="pw-sp" data-testid="sign-abuse-reports">
      <div className="pw-sp-head">
        <h1 className="pw-sp-title">Aramo Sign abuse reports</h1>
        <p className="pw-sp-intro">
          “Report this email” reports from every sender. A report on a Business sender never pauses the organization: review it here.
        </p>
      </div>
      <div className="pw-sp-report__acts" role="group" aria-label="Show">
        {(['OPEN', 'ALL'] as const).map((f) => (
          <Button
            key={f}
            unstyled
            className={f === filter ? 'pw-sp-rbtn pw-sp-rbtn--priv' : 'pw-sp-rbtn'}
            aria-pressed={f === filter}
            onClick={() => setFilter(f)}
          >
            {f === 'OPEN' ? 'Open' : 'All'}
          </Button>
        ))}
      </div>
      {error !== null ? (
        <div role="alert" className="pw-alert pw-alert--error pw-sp-gap">
          {error}
        </div>
      ) : null}
      {items === null && error === null ? <SkeletonPanel /> : null}
      {items !== null && items.length === 0 ? (
        <div data-testid="sign-abuse-empty">
          <EmptyState title={filter === 'OPEN' ? 'No open reports' : 'No reports'} />
        </div>
      ) : null}
      {(items ?? []).map((r) => {
        const rp = REPORT_PILL[r.outcome];
        return (
          <div key={r.id} className="pw-sp-report" data-testid={`sign-abuse-report-${r.id}`}>
            <div className="pw-sp-report__head">
              <b className="pw-sp-report__cat">{reportCategory(r)}</b>
              <Pill tone={rp.tone}>{rp.label}</Pill>
              <span className="pw-sp-report__at">{formatDate(r.created_at)}</span>
            </div>
            <div className="pw-sp-report__note" data-testid="sign-abuse-sender">
              Sender: {senderLabel(r)} · reporter domain {r.reporter_domain}
            </div>
            {r.note ? <div className="pw-sp-report__note">“{r.note}”</div> : null}
            {r.outcome_reason ? <div className="pw-sp-report__decision">Decision: {r.outcome_reason}</div> : null}
            {r.outcome === 'OPEN' ? (
              <div className="pw-sp-report__acts">
                {REPORT_DECISIONS.map((o) => (
                  <Button
                    key={o}
                    unstyled
                    className={o === 'CONFIRMED' ? 'pw-sp-rbtn pw-sp-rbtn--priv' : 'pw-sp-rbtn'}
                    onClick={() => setDeciding({ report: r, outcome: o })}
                  >
                    {REPORT_BUTTON[o]}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      {deciding !== null ? (
        <DecideDialog
          report={deciding.report}
          outcome={deciding.outcome}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null);
            toast.show('Report updated.');
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function DecideDialog({
  report,
  outcome,
  onClose,
  onDone,
}: {
  readonly report: SignAbuseQueueItem;
  readonly outcome: ReportDecision;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const spec = reportDecisionSpec(outcome);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await platformApi.decidePersonalReport(report.id, { outcome, reason: reason.trim() });
      onDone();
    } catch (e) {
      setError(loadErrorText(e, 'The outcome couldn’t be recorded. Try again.'));
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={spec.label}
      consequence={spec.consequence}
      error={error}
      commitLabel={spec.label}
      tone={spec.tone}
      canCommit={reason.trim().length > 0}
      busy={busy}
      onCommit={() => void commit()}
    >
      <FieldTextArea label="Reason" value={reason} onChange={setReason} max={REASON_MAX} />
    </ConfirmDialog>
  );
}
