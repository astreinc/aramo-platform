import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Select, useOptionalToast } from '@aramo/fe-foundation';

import {
  ConfirmDialog,
  DetailDrawer,
  EmptyState,
  FieldAck,
  FieldText,
  FieldTextArea,
  FilterBar,
  Pill,
  Skeleton,
  formatDate,
  formatDateRelative,
  formatRelative,
  formatTimestamp,
} from '../components';
import {
  platformApi,
  type PersonalAbuseReport,
  type PersonalReviewAction,
  type PersonalReviewItem,
} from '../platform-api';

import {
  ACTION_BUTTON,
  REASON_MAX,
  REPORT_BUTTON,
  REPORT_DECISIONS,
  REPORT_PILL,
  REVIEW_FILTERS,
  UNTIL_IN_PAST,
  actionSpec,
  actionsFor,
  applyRiskView,
  filterLabel,
  loadErrorText,
  phoneLabel,
  phoneStepLabel,
  reasonLabel,
  reportCategory,
  reportDecisionSpec,
  reviewErrorText,
  signalLabel,
  signalTotal,
  statePill,
  untilAsUtc,
  visibleItems,
  type ReportDecision,
  type ReviewFilter,
  type ReviewSort,
} from './personal-review-model';
import './personal.css';

// PLATFORM-UX-1 F-6 (handoff §8.1; amendment 3, 11; directive R-19) — the Sign
// Personal review queue: a state filter with counts, a sort, the accounts table
// and the account drawer (facts, recorded signals, abuse reports, the footer
// actions allowed by the account's state). The route is gated on
// platform:tenant:lifecycle:manage in App.tsx (amendment 3 — the API needs it to
// read, so there is no view-only state). Every action needs a reason and is
// audited server-side. Clearing review never verifies the phone (§6.3).

export function PersonalReviewView() {
  const toast = useOptionalToast();
  const [items, setItems] = useState<PersonalReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReviewFilter>('ALL');
  const [sort, setSort] = useState<ReviewSort>('signed');
  // The open account. Kept as a snapshot so an account that leaves the queue
  // after an action (cleared, closed) stays viewable — reports included.
  const [open, setOpen] = useState<PersonalReviewItem | null>(null);

  const load = useCallback(async (): Promise<PersonalReviewItem[] | null> => {
    setError(null);
    try {
      const r = await platformApi.listPersonalReview();
      setItems(r.items);
      return r.items;
    } catch (e) {
      setError(loadErrorText(e, 'The review queue couldn’t be loaded. Try again.'));
      return null;
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const all = items ?? [];
  const rows = useMemo(() => visibleItems(all, filter, sort), [all, filter, sort]);
  const options = REVIEW_FILTERS.map((f) => ({
    value: f,
    label: filterLabel(f),
    count: all.filter((i) => f === 'ALL' || i.state === f).length,
  }));

  const onChanged = (updated: PersonalReviewItem, message: string): void => {
    toast.show(message);
    setOpen(updated);
    void load().then((fresh) => {
      const again = fresh?.find((i) => i.tenant_id === updated.tenant_id);
      if (again) setOpen((cur) => (cur !== null && cur.tenant_id === again.tenant_id ? again : cur));
    });
  };

  return (
    <div className="pw-sp" data-testid="personal-review">
      <div className="pw-sp-head">
        <h1 className="pw-sp-title">Sign Personal review queue</h1>
        <p className="pw-sp-intro">
          Free Sign Personal accounts flagged for abuse review. Risk points are evidence from signals, not a rating of the person.
        </p>
      </div>
      <FilterBar label="State" options={options} value={filter} onChange={setFilter}>
        <label className="pw-sp-sort">
          Sort
          <Select
            unstyled
            className="pw-sp-sort__select"
            value={sort}
            onChange={(e) => setSort(e.target.value as ReviewSort)}
          >
            <option value="signed">Signed up, newest</option>
            <option value="until">Restricted until, soonest</option>
          </Select>
        </label>
      </FilterBar>
      <div className="pw-sp-card">
        {error !== null ? (
          <div role="alert" className="pw-alert pw-alert--error pw-sp-card__alert">
            {error}
          </div>
        ) : null}
        <div className="pw-sp-scroll">
          <table className="pw-sp-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>State</th>
                <th>Reason</th>
                <th className="pw-sp-num">Risk points</th>
                <th>Phone</th>
                <th className="pw-sp-num">Reports</th>
                <th>Signed up</th>
                <th>Restricted until</th>
              </tr>
            </thead>
            <tbody>
              {items === null && error === null ? <SkeletonRows /> : null}
              {rows.map((it) => (
                <ReviewRow
                  key={it.tenant_id}
                  item={it}
                  selected={open?.tenant_id === it.tenant_id}
                  onOpen={() => setOpen(it)}
                />
              ))}
            </tbody>
          </table>
        </div>
        {items !== null && rows.length === 0 ? (
          <div data-testid="personal-review-empty">
            <EmptyState size="lg" title="Nothing in this state" body="No Sign Personal accounts match this filter." />
          </div>
        ) : null}
      </div>
      {open !== null ? (
        <AccountDrawer item={open} onClose={() => setOpen(null)} onChanged={onChanged} />
      ) : null}
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <tr key={i} aria-hidden="true">
          {[160, 80, 140, 40, 80, 30, 90, 90].map((w, j) => (
            <td key={j}>
              <Skeleton width={w} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function ReviewRow({
  item: it,
  selected,
  onOpen,
}: {
  readonly item: PersonalReviewItem;
  readonly selected: boolean;
  readonly onOpen: () => void;
}) {
  const pill = statePill(it.state);
  return (
    <tr
      className={selected ? 'pw-sp-row pw-sp-row--on' : 'pw-sp-row'}
      onClick={onOpen}
      data-testid={`personal-review-${it.tenant_id}`}
    >
      <td>
        <Button
          unstyled
          className="pw-sp-row__name"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {it.tenant_name}
        </Button>
        <div className="pw-sp-row__email">{it.owner_email ?? '—'}</div>
      </td>
      <td>
        <Pill tone={pill.tone}>{pill.label}</Pill>
        <div className="pw-sp-row__owed">{it.review_pending === true ? 'Review owed' : ''}</div>
      </td>
      <td className="pw-sp-row__reason">{reasonLabel(it.reason)}</td>
      <td className="pw-sp-num pw-sp-row__points" data-testid="personal-review-points">
        {it.risk_points ?? '—'}
      </td>
      <td className="pw-sp-row__text">{phoneLabel(it)}</td>
      <td className="pw-sp-num pw-sp-row__text">{it.report_count ?? '—'}</td>
      <td className="pw-sp-row__text pw-sp-nowrap">
        {formatDate(it.created_at)}
        <div className="pw-sp-row__sub">{formatRelative(it.created_at)}</div>
      </td>
      <td className="pw-sp-row__text pw-sp-nowrap">{it.restricted_until !== null ? formatDate(it.restricted_until) : '—'}</td>
    </tr>
  );
}

// ── the account drawer ──────────────────────────────────────────────────────

function AccountDrawer({
  item: it,
  onClose,
  onChanged,
}: {
  readonly item: PersonalReviewItem;
  readonly onClose: () => void;
  readonly onChanged: (updated: PersonalReviewItem, message: string) => void;
}) {
  const toast = useOptionalToast();
  const [reports, setReports] = useState<PersonalAbuseReport[] | null>(null);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [acting, setActing] = useState<PersonalReviewAction | null>(null);
  const [deciding, setDeciding] = useState<{ report: PersonalAbuseReport; outcome: ReportDecision } | null>(null);

  const loadReports = useCallback(async () => {
    setReportsError(null);
    try {
      setReports((await platformApi.listPersonalReports(it.tenant_id)).items);
    } catch (e) {
      setReportsError(loadErrorText(e, 'Reports couldn’t be loaded. Try again.'));
    }
  }, [it.tenant_id]);
  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  const pill = statePill(it.state);
  const acts = actionsFor(it);
  const closed = it.state === 'closed';
  const reportCount = reports !== null ? reports.length : it.report_count;
  const facts: ReadonlyArray<readonly [string, string]> = [
    ['Tenant', it.tenant_name],
    ['Reason', reasonLabel(it.reason)],
    ['Phone', `${phoneLabel(it)} · ${phoneStepLabel(it)}`],
    [
      'Signup network',
      it.geo != null ? `${it.geo.country ?? 'Unknown'} · ${it.geo.db_version ?? 'no location database'}` : '—',
    ],
    ['Signed up', formatDateRelative(it.created_at)],
    ['Restricted until', it.restricted_until !== null ? formatTimestamp(it.restricted_until) : '—'],
    ['Abuse reports', reportCount != null ? String(reportCount) : '—'],
    ['Review owed', it.review_pending === true ? 'Yes' : 'No'],
  ];

  const footer =
    acts.length > 0 ? (
      <>
        {acts.map((a) => (
          <Button
            key={a}
            unstyled
            className={a === 'close' ? 'pw-sp-act pw-sp-act--danger' : 'pw-sp-act'}
            onClick={() => setActing(a)}
          >
            {ACTION_BUTTON[a]}
          </Button>
        ))}
      </>
    ) : undefined;

  return (
    <DetailDrawer
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={
        <>
          <b className="pw-sp-drawer__name">{it.tenant_name}</b>
          <Pill tone={pill.tone}>{pill.label}</Pill>
        </>
      }
      subtitle={`${it.owner_email ?? '—'} · ${it.tenant_id}`}
      footer={footer}
    >
      <div data-testid="personal-drawer">
        <dl className="pw-sp-facts">
          {facts.map(([k, v]) => (
            <div key={k} className="pw-sp-facts__row">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <h3 className="pw-sp-h3">
          <span>Signals</span>
          <span className="pw-sp-h3__aside" data-testid="personal-signal-total">
            {signalTotal(it)} risk points from recorded signals
          </span>
        </h3>
        <div className="pw-sp-signals" data-testid="personal-review-signals">
          {it.signals.length === 0 ? <div className="pw-sp-signal pw-sp-signal--none">No signals recorded.</div> : null}
          {it.signals.map((s, i) => (
            <div key={`${s.key}-${String(i)}`} className="pw-sp-signal">
              <span className="pw-sp-signal__label">{signalLabel(s.key)}</span>
              <span className="pw-sp-signal__pts">+{s.points}</span>
              <span className="pw-sp-signal__code">
                {s.key}
                {s.detail ? ` · ${s.detail}` : ''}
              </span>
            </div>
          ))}
        </div>
        <h3 className="pw-sp-h3">Reports</h3>
        {reportsError !== null ? (
          <div role="alert" className="pw-alert pw-alert--error pw-sp-gap">
            {reportsError}
          </div>
        ) : null}
        {reports === null && reportsError === null ? (
          <div className="pw-sp-gap" aria-busy="true">
            <span className="pw-sr-only" role="status">
              Loading reports…
            </span>
            <Skeleton height={64} radius={10} />
          </div>
        ) : null}
        {reports !== null && reports.length === 0 ? (
          <div className="pw-sp-noreports" data-testid="personal-reports-empty">
            No abuse reports.
          </div>
        ) : null}
        {(reports ?? []).map((r) => {
          const rp = REPORT_PILL[r.outcome];
          return (
            <div key={r.id} className="pw-sp-report" data-testid={`personal-report-${r.id}`}>
              <div className="pw-sp-report__head">
                <b className="pw-sp-report__cat">{reportCategory(r)}</b>
                <Pill tone={rp.tone}>{rp.label}</Pill>
                <span className="pw-sp-report__at">{formatDate(r.created_at)}</span>
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
        {closed ? (
          <div className="pw-sp-closed" data-testid="personal-closed-note">
            This account is closed. Reports stay viewable; no further actions.
          </div>
        ) : null}
      </div>
      {acting !== null ? (
        <ReviewActionDialog
          item={it}
          action={acting}
          onClose={() => setActing(null)}
          onDone={(updated) => {
            const label = actionSpec(acting, it).label;
            setActing(null);
            onChanged(updated, `${label}: ${it.tenant_name}.`);
          }}
        />
      ) : null}
      {deciding !== null ? (
        <ReportDecisionDialog
          item={it}
          report={deciding.report}
          outcome={deciding.outcome}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null);
            toast.show('Report updated.');
            void loadReports();
          }}
        />
      ) : null}
    </DetailDrawer>
  );
}

// ── dialogs ────────────────────────────────────────────────────────────────

const REASON_HELPER = 'Recorded on the account. The account holder doesn’t see it.';

export function ReviewActionDialog({
  item: it,
  action,
  onClose,
  onDone,
  now = () => new Date(),
}: {
  readonly item: PersonalReviewItem;
  readonly action: PersonalReviewAction;
  readonly onClose: () => void;
  readonly onDone: (updated: PersonalReviewItem) => void;
  /** Clock seam (tests). */
  readonly now?: () => Date;
}) {
  const spec = actionSpec(action, it);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCommit = reason.trim().length > 0 && (action !== 'close' || ack);

  const commit = async (): Promise<void> => {
    const untilAt = action === 'restrict' ? untilAsUtc(until) : null;
    if (untilAt !== null && untilAt.getTime() <= now().getTime()) {
      setError(UNTIL_IN_PAST);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await platformApi.personalReviewAction(it.tenant_id, action, {
        reason: reason.trim(),
        ...(untilAt !== null ? { until: untilAt.toISOString() } : {}),
      });
      onDone(applyRiskView(it, r, { to: spec.to, reason: reason.trim(), clearedReview: action === 'clear-review' }));
    } catch (e) {
      setError(reviewErrorText(e, it, 'The action couldn’t be completed. Try again.'));
      setBusy(false);
    }
  };

  const from = statePill(it.state);
  const to = statePill(spec.to);
  const consequence =
    action === 'clear-review' && it.review_clears_phone_step === true ? (
      <>
        {spec.consequence}{' '}
        <span data-testid="personal-clear-lifts-phone">
          Clearing review doesn’t verify the phone. Phone verification is unavailable right now, so this also lifts the
          account’s phone step; the phone stays recorded as not verified.
        </span>
      </>
    ) : (
      spec.consequence
    );

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`${spec.label} — ${it.tenant_name}`}
      from={from}
      to={to}
      consequence={consequence}
      error={error}
      commitLabel={spec.label}
      tone={spec.tone}
      canCommit={canCommit}
      busy={busy}
      onCommit={() => void commit()}
    >
      <FieldTextArea label="Reason" value={reason} onChange={setReason} max={REASON_MAX} helper={REASON_HELPER} />
      {action === 'restrict' ? (
        <FieldText
          label="Restrict until (optional)"
          type="datetime-local"
          value={until}
          onChange={(v) => {
            setUntil(v);
            setError(null);
          }}
          helper="Leave empty to restrict until someone reinstates it. Times are UTC."
        />
      ) : null}
      {action === 'close' ? <FieldAck label="I understand this closes the account." checked={ack} onChange={setAck} /> : null}
    </ConfirmDialog>
  );
}

function ReportDecisionDialog({
  item,
  report,
  outcome,
  onClose,
  onDone,
}: {
  readonly item: PersonalReviewItem;
  readonly report: PersonalAbuseReport;
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
      setError(reviewErrorText(e, item, 'The outcome couldn’t be recorded. Try again.'));
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
