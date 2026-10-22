import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, Button, Checkbox, Dialog, FormField, InlineAlert, Input, TextArea } from '@aramo/fe-foundation';

import {
  platformApi,
  type AbuseReportOutcome,
  type PersonalAbuseReport,
  type PersonalReviewAction,
  type PersonalReviewItem,
  type PersonalRiskState,
} from '../platform-api';

// Aramo Sign Personal (Free) §6.5 — the operator's Personal review queue: accounts
// in review, accounts restricted (including by abuse reports), with every signal
// and its risk points visible. Actions (clear review, restrict, reinstate, close)
// each need a reason and are audited server-side. Clearing review never verifies
// the phone (§6.3): phone assurance comes only from a real SMS verification. While
// phone verification is unavailable (no SMS provider), clearing review also lifts
// an outstanding phone step (PO 2026-10-21 "Review replaces phone") — the phone
// still counts as not verified.

const SIGNAL_LABEL: Record<string, string> = {
  robot_check_low: 'Security check low',
  robot_check_failed: 'Security check failed',
  honeypot_filled: 'Hidden form field filled',
  network_hosting: 'Hosting, VPN or Tor network',
  network_hosting_vpn_tor: 'Hosting, VPN or Tor network',
  ip_velocity: 'Several signups from the same IP',
  ip_signups_24h: 'Several signups from the same IP',
  phone_ip_country_mismatch: 'Phone country differs from network country',
  // GeoLite2 network location: a risk signal only, never proof of where someone lives.
  ip_country_outside: 'Network location outside the supported countries',
  ip_country_unknown: 'Network location unknown',
  gmail_alias: 'Gmail alias of an existing account',
  gmail_alias_of_existing: 'Gmail alias of an existing account',
  fast_form: 'Form completed very quickly',
  random_name: 'Random-looking name or address',
  random_looking: 'Random-looking name or address',
  phone_reused: 'Phone already used by another account',
  abuse_reports: 'Abuse reports',
  // Review reasons recorded on the account.
  send_location_outside: 'Sent from outside the supported countries',
  send_location_unknown: 'Sent from an unknown network location',
  step_up_phone_unavailable: 'Phone step needed; phone verification unavailable',
};

export function signalLabel(key: string): string {
  return SIGNAL_LABEL[key] ?? key.replace(/[_.]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

const STATE_LABEL: Record<PersonalRiskState, string> = {
  clear: 'Clear',
  review: 'In review',
  restricted: 'Restricted',
  closed: 'Closed',
};

const STATE_STYLE: Record<PersonalRiskState, CSSProperties> = {
  clear: { background: 'var(--ok-tint)', color: 'var(--ok)' },
  review: { background: 'var(--info-tint)', color: 'var(--info)' },
  restricted: { background: 'var(--warn-tint)', color: 'var(--warn)' },
  closed: { background: 'var(--surface-2)', color: 'var(--muted)' },
};

const ACTIONS_BY_STATE: Record<PersonalRiskState, PersonalReviewAction[]> = {
  review: ['clear-review', 'restrict', 'close'],
  restricted: ['reinstate', 'close'],
  clear: ['restrict', 'close'],
  closed: [],
};

const ACTION_LABEL: Record<PersonalReviewAction, string> = {
  'clear-review': 'Clear review',
  restrict: 'Restrict',
  reinstate: 'Reinstate',
  close: 'Close account',
};

/** The actions for an item; a review owed under a restriction can be cleared too. */
export function actionsFor(it: PersonalReviewItem): PersonalReviewAction[] {
  const base = ACTIONS_BY_STATE[it.state] ?? [];
  return it.state === 'restricted' && it.review_pending === true ? ['clear-review', ...base] : base;
}

const OUTCOME_LABEL: Record<Exclude<AbuseReportOutcome, 'OPEN'>, string> = {
  CONFIRMED: 'Confirm',
  FALSE_REPORT: 'Mark false report',
  DISMISSED: 'Dismiss',
};

const OUTCOME_SHOWN: Record<AbuseReportOutcome, string> = {
  OPEN: 'Open',
  CONFIRMED: 'Confirmed',
  FALSE_REPORT: 'False report',
  DISMISSED: 'Dismissed',
};

function fmt(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function errorText(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const reason = e.details?.['reason'];
  return `${e.message}${typeof reason === 'string' ? ` (${reason})` : ''}`;
}

export function PersonalReviewView() {
  const [items, setItems] = useState<PersonalReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [acting, setActing] = useState<{ item: PersonalReviewItem; action: PersonalReviewAction } | null>(null);
  const [reportsFor, setReportsFor] = useState<PersonalReviewItem | null>(null);

  const load = useCallback(() => {
    setError(null);
    platformApi
      .listPersonalReview()
      .then((r) => setItems(r.items))
      .catch((e: unknown) => setError(errorText(e, 'Could not load the review queue.')));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="pw-page" data-testid="personal-review">
      <div className="pw-page__head">
        <h1 className="pw-page__title">Personal review queue</h1>
        <Link to="/personal-invites">Issue pilot invite</Link>
      </div>
      <p className="pw-audit__detail" style={{ marginTop: 0 }}>
        Aramo Sign Personal accounts in review or restricted. A person decides every outcome; each action is audited with its reason.
      </p>
      {done !== null ? <InlineAlert variant="success">{done}</InlineAlert> : null}
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      {items === null && error === null ? <p role="status">Loading…</p> : null}
      {items !== null && items.length === 0 ? <p data-testid="personal-review-empty">No accounts need review.</p> : null}
      {items !== null && items.length > 0 ? (
        <ul className="pw-audit" aria-label="Accounts needing review">
          {items.map((it) => (
            <li key={it.tenant_id} className="pw-audit__item" data-testid={`personal-review-${it.tenant_id}`}>
              <div className="pw-audit__head">
                <span>
                  <Link to={`/tenants/${it.tenant_id}`}>{it.tenant_name}</Link>
                  {it.owner_email !== null ? <span className="pw-audit__meta"> · {it.owner_email}</span> : null}
                </span>
                <span
                  className="pw-badge"
                  style={{ ...STATE_STYLE[it.state], padding: '2px 9px', borderRadius: 999, fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap' }}
                >
                  {STATE_LABEL[it.state] ?? it.state}
                </span>
              </div>
              <dl className="pw-facts" style={{ marginTop: 8 }}>
                <dt>Reason</dt>
                <dd>{it.reason !== null ? (SIGNAL_LABEL[it.reason] ?? it.reason) : '—'}</dd>
                <dt>Risk points</dt>
                <dd data-testid="personal-review-points">{it.risk_points ?? '—'}</dd>
                <dt>Phone verified</dt>
                <dd>{it.phone_verified_at !== null ? fmt(it.phone_verified_at) : 'No'}</dd>
                {it.step_up_cleared_by === 'review' ? (
                  <>
                    <dt>Phone step</dt>
                    <dd data-testid="personal-review-step-cleared">Lifted by review (phone not verified)</dd>
                  </>
                ) : null}
                {it.geo != null ? (
                  <>
                    <dt>Signup network location</dt>
                    <dd data-testid="personal-review-geo">
                      {it.geo.country ?? 'Unknown'}
                      <span className="pw-audit__meta"> · {it.geo.db_version ?? 'no location database'}</span>
                    </dd>
                  </>
                ) : null}
                {it.restricted_until !== null ? (
                  <>
                    <dt>Restricted until</dt>
                    <dd>{fmt(it.restricted_until)}</dd>
                  </>
                ) : it.state === 'restricted' ? (
                  <>
                    <dt>Restricted until</dt>
                    <dd>Reinstated by an operator</dd>
                  </>
                ) : null}
                {it.report_count != null ? (
                  <>
                    <dt>Abuse reports</dt>
                    <dd>{it.report_count}</dd>
                  </>
                ) : null}
                <dt>Signed up</dt>
                <dd>{fmt(it.created_at)}</dd>
              </dl>
              {it.signals.length > 0 ? (
                <ul className="pw-audit__detail" aria-label={`Signals for ${it.tenant_name}`} data-testid="personal-review-signals" style={{ paddingLeft: 18 }}>
                  {it.signals.map((s) => (
                    <li key={s.key}>
                      {signalLabel(s.key)} <span className="pw-audit__meta">+{s.points}</span>
                      {s.detail ? <span className="pw-audit__meta"> · {s.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {it.review_pending === true ? (
                <p className="pw-audit__detail" data-testid="personal-review-owed">A review is still owed. It holds sending even after this restriction ends.</p>
              ) : null}
              {actionsFor(it).length ? (
                <div className="pw-actions" style={{ marginTop: 8 }}>
                  <Button variant="secondary" size="sm" onClick={() => setReportsFor(it)} data-testid="personal-review-reports">
                    Reports
                  </Button>
                  {actionsFor(it).map((a) => (
                    <Button key={a} variant={a === 'close' ? 'secondary' : 'primary'} size="sm" onClick={() => setActing({ item: it, action: a })}>
                      {ACTION_LABEL[a]}
                    </Button>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {reportsFor !== null ? <ReportsDialog item={reportsFor} onClose={() => setReportsFor(null)} /> : null}
      {acting !== null ? (
        <ReviewActionDialog
          item={acting.item}
          action={acting.action}
          onClose={() => setActing(null)}
          onDone={() => {
            setDone(`${ACTION_LABEL[acting.action]}: ${acting.item.tenant_name}.`);
            setActing(null);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

function ReviewActionDialog({
  item,
  action,
  onClose,
  onDone,
}: {
  item: PersonalReviewItem;
  action: PersonalReviewAction;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await platformApi.personalReviewAction(item.tenant_id, action, {
        reason: reason.trim(),
        ...(action === 'restrict' && until !== '' ? { until: new Date(until).toISOString() } : {}),
      });
      onDone();
    } catch (e) {
      setError(errorText(e, 'Action failed.'));
      setBusy(false);
    }
  };

  const disabled = busy || reason.trim() === '' || (action === 'close' && !confirm);

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`${ACTION_LABEL[action]} — ${item.tenant_name}`}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={disabled} data-testid="personal-action-confirm">
            {busy ? 'Working…' : ACTION_LABEL[action]}
          </Button>
        </>
      }
    >
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      {action === 'clear-review' ? (
        item.review_clears_phone_step === true ? (
          <p className="pw-audit__detail" data-testid="personal-clear-lifts-phone">
            Clearing review does not verify the phone. Phone verification is unavailable right now, so clearing review also lifts this account&apos;s phone step and lets it send. The phone stays recorded as not verified.
          </p>
        ) : (
          <p className="pw-audit__detail" data-testid="personal-clear-keeps-phone">
            Clearing review does not verify the phone. An account that needs phone verification stays blocked from sending until it verifies.
          </p>
        )
      ) : null}
      {action === 'restrict' ? <p className="pw-audit__detail">New sends pause. Envelopes already sent are not affected.</p> : null}
      <FormField label="Reason (required)">
        <TextArea unstyled className="tc-input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      {action === 'restrict' ? (
        <FormField label="Restrict until (optional)" helper="Leave empty to keep the restriction until an operator reinstates the account.">
          <Input unstyled className="tc-input" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
        </FormField>
      ) : null}
      {action === 'close' ? (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <Checkbox checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>I understand this closes the personal account.</span>
        </label>
      ) : null}
    </Dialog>
  );
}

// §6.4 — the reports behind an account; a person records each outcome. Marking a
// report false lowers that reporter's weight in future reports.
function ReportsDialog({ item, onClose }: { item: PersonalReviewItem; onClose: () => void }) {
  const [reports, setReports] = useState<PersonalAbuseReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ report: PersonalAbuseReport; outcome: Exclude<AbuseReportOutcome, 'OPEN'> } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    platformApi
      .listPersonalReports(item.tenant_id)
      .then((r) => setReports(r.items))
      .catch((e: unknown) => setError(errorText(e, 'Could not load reports.')));
  }, [item.tenant_id]);
  useEffect(load, [load]);

  const decide = async (): Promise<void> => {
    if (deciding === null) return;
    setBusy(true);
    setError(null);
    try {
      await platformApi.decidePersonalReport(deciding.report.id, { outcome: deciding.outcome, reason: reason.trim() });
      setDeciding(null);
      setReason('');
      load();
    } catch (e) {
      setError(errorText(e, 'Could not record the outcome.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Abuse reports — ${item.tenant_name}`}
      size="md"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      {reports === null && error === null ? <p role="status">Loading…</p> : null}
      {reports !== null && reports.length === 0 ? <p data-testid="personal-reports-empty">No reports.</p> : null}
      {reports !== null && reports.length > 0 ? (
        <ul className="pw-audit" aria-label="Abuse reports" data-testid="personal-reports">
          {reports.map((r) => (
            <li key={r.id} className="pw-audit__item">
              <div className="pw-audit__head">
                <span>{r.reason ?? 'No reason given'}</span>
                <span className="pw-audit__meta">{OUTCOME_SHOWN[r.outcome]}</span>
              </div>
              <p className="pw-audit__detail">
                From {r.reporter_domain} · weight {r.weight.toFixed(2)} · {fmt(r.created_at)}
                {r.note ? ` · “${r.note}”` : ''}
              </p>
              {r.outcome === 'OPEN' ? (
                <div className="pw-actions">
                  {(Object.keys(OUTCOME_LABEL) as Exclude<AbuseReportOutcome, 'OPEN'>[]).map((o) => (
                    <Button key={o} size="sm" variant="secondary" onClick={() => setDeciding({ report: r, outcome: o })}>
                      {OUTCOME_LABEL[o]}
                    </Button>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {deciding !== null ? (
        <div style={{ marginTop: 12 }}>
          <FormField label={`Reason for “${OUTCOME_LABEL[deciding.outcome]}” (required)`}>
            <TextArea unstyled className="tc-input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <div className="pw-actions">
            <Button variant="secondary" onClick={() => setDeciding(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void decide()} disabled={busy || reason.trim() === ''} data-testid="personal-report-decide">
              {busy ? 'Saving…' : OUTCOME_LABEL[deciding.outcome]}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
