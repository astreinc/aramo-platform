import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '@aramo/fe-foundation';

import {
  Button,
  Card,
  CardHead,
  ErrorState,
  LoadingState,
  StatusPill,
  safeErrorMessage,
} from '../ui';
import { findSubmittalForTalentJob } from '../submittals/submittals-api';

import { getSubmittalWorkspace } from './submittal-workspace-api';
import { RecordSubmittalDialog } from './RecordSubmittalDialog';
import { ClientResponseSection } from './ClientResponseSection';
import {
  clientSelectionPill,
  deliveryLabel,
  entryActionLabel,
  formatDate,
  formatDateTime,
  isHistorical,
  lifecyclePill,
  remediationOnRequisition,
  requirementRow,
  requiredCounts,
  waitingLabel,
} from './present';
import type { SubmittalWorkspaceView as WorkspaceView } from './submittal-workspace-types';

import './submittal-workspace.css';

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function formatRate(amount: string | null, currency: string | null, period: string | null): string | null {
  if (amount === null) return null;
  const sym = currency === 'USD' ? '$' : currency ? `${currency} ` : '';
  const per = period === 'HOURLY' ? ' / hour' : period === 'DAILY' ? ' / day' : period === 'ANNUAL' ? ' / year' : period ? ` / ${period.toLowerCase()}` : '';
  return `${sym}${amount}${per}`;
}

// SW-5 — the Submittal Workspace: the canonical surface for an EXISTING submittal
// (preparation, readiness, record-submittal, provenance, client response). It
// COMPOSES the SW-4 read projection and reuses the SW-3 readiness verbatim — it
// owns no business truth. Lifecycle (header pill) and readiness (banner) are kept
// visually distinct; the primary CTA consumes the server-owned
// actions.can_submit_to_client (never a FE recomputation of authorization).
export function SubmittalWorkspaceView() {
  const { talentId, requisitionId } = useParams<{ talentId: string; requisitionId: string }>();
  const [searchParams] = useSearchParams();
  const focus = searchParams.get('focus');

  const [model, setModel] = useState<WorkspaceView | null>(null);
  const [submittalId, setSubmittalId] = useState<string | null>(null);
  const [noSubmittal, setNoSubmittal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [raceConflict, setRaceConflict] = useState(false);

  const prepRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!talentId || !requisitionId) return;
    setLoading(true);
    setError(null);
    try {
      // D-2 — no entry point carries a submittal_id; resolve the authoritative
      // submittal for this (talent, requisition) before loading the workspace.
      const lookup = await findSubmittalForTalentJob(talentId, requisitionId);
      if (lookup.submittal === null) {
        setNoSubmittal(true);
        setModel(null);
        return;
      }
      setNoSubmittal(false);
      setSubmittalId(lookup.submittal.id);
      const view = await getSubmittalWorkspace(lookup.submittal.id);
      setModel(view);
      setRaceConflict(false);
    } catch (err) {
      // Concealment: a 404 means the submittal does not exist for this tenant OR its
      // requisition is outside the caller's visible set — the same neutral message
      // either way (never reveal whether a hidden submittal exists).
      if (err instanceof ApiError && err.status === 404) {
        setError('This submittal isn’t available.');
      } else {
        setError(safeErrorMessage(err, 'Couldn’t load the submittal workspace. Please try again.'));
      }
    } finally {
      setLoading(false);
    }
  }, [talentId, requisitionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // §15 — focus is a presentation hint only (scroll/highlight the named row). It
  // never decides whether a requirement blocks; readiness remains authoritative.
  useEffect(() => {
    if (model !== null && focus && prepRef.current) {
      const t = setTimeout(() => {
        prepRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [model, focus]);

  const derived = useMemo(() => {
    if (model === null) return null;
    const state = model.submittal.state;
    const historical = isHistorical(state);
    const submittedFamily = state === 'submitted_to_client' || state === 'confirmed';
    const revoked = state === 'revoked';
    const ready = model.readiness.status === 'READY';
    const counts = requiredCounts(model.readiness);
    return { state, historical, submittedFamily, revoked, ready, counts };
  }, [model]);

  if (loading && model === null && !noSubmittal) {
    return (
      <section className="sw-root">
        <LoadingState label="Loading submittal workspace…" />
      </section>
    );
  }

  if (noSubmittal) {
    return (
      <section className="sw-root">
        <Card>
          <div className="sw-empty">
            <b>No submittal yet</b>
            <p>There is no submittal for this talent on this requisition.</p>
            <Link className="sw-link" to={`/talent/${talentId}/submittal/${requisitionId}`}>
              Prepare submittal →
            </Link>
          </div>
        </Card>
      </section>
    );
  }

  if (error !== null && model === null) {
    return (
      <section className="sw-root">
        <ErrorState message={error} onRetry={() => void load()} />
      </section>
    );
  }

  if (model === null || derived === null) return null;

  const { identity, context, pipeline, readiness, engagement, commercial, delivery, client_selection, actions } = model;
  const { state, historical, submittedFamily, revoked, ready, counts } = derived;

  const who = identity.talent.name ?? 'Talent';
  const role = identity.requisition.title;
  const client = identity.company?.name ?? null;
  const pill = lifecyclePill(state);
  const cPill = clientSelectionPill(client_selection.state);

  const liveBillLabel = commercial
    ? formatRate(commercial.live_bill_rate_amount, commercial.live_bill_rate_currency, commercial.live_bill_rate_period)
    : null;
  const submittedBillLabel = commercial
    ? formatRate(commercial.submitted_bill_rate, commercial.submitted_rate_currency, commercial.submitted_rate_period)
    : null;

  // CTA (§3/§D) — the primary action consumes the server-owned final authority.
  const canRecord = actions.can_submit_to_client && !historical && !raceConflict;
  const readyButViewOnly = ready && !actions.submit_authority && !historical && !raceConflict;
  const reviewBlockers = !ready && actions.submit_authority && !historical && !raceConflict;

  const missing = readiness.requirements.filter((r) => r.required && !r.satisfied);

  // Header next-step copy — derived from authoritative facts only.
  let headLine: string;
  if (raceConflict) headLine = 'The available submittal slot was filled by another submittal.';
  else if (revoked) headLine = `Revoked${delivery.external_submitted_at ? '' : ''} · no longer presented to the client`;
  else if (submittedFamily) {
    const csWaiting = waitingLabel(client_selection.opened_at);
    headLine = `Submitted to ${client ?? 'the client'}${delivery.submitted_at ? ` ${formatDate(delivery.submitted_at)}` : ''}${delivery.delivery_channel ? ` · ${deliveryLabel(delivery.delivery_channel)}` : ''}${cPill ? ` · ${cPill.label}` : ''}${cPill && csWaiting ? ` ${csWaiting}` : ''}`;
  } else if (!ready) {
    headLine = `Not ready to submit · ${missing.length} required item${missing.length === 1 ? ' needs' : 's need'} attention`;
  } else if (readyButViewOnly) {
    headLine = 'Submitting is done by the requisition team';
  } else {
    headLine = `Next: record the submittal with ${client ?? 'the client'}`;
  }

  // Readiness banner (distinct from the lifecycle pill).
  let banner: { tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info'; title: string; body: string; action?: { label: string; onClick: () => void } } | null = null;
  if (raceConflict) {
    banner = {
      tone: 'danger',
      title: 'Submittal could not be recorded',
      body: `The last available submittal slot on this requisition was filled by another submittal. Nothing was recorded for ${who.split(' ')[0]}.`,
      action: { label: 'Refresh status', onClick: () => void load() },
    };
  } else if (revoked) {
    banner = { tone: 'neutral', title: 'Submittal revoked', body: 'This talent is no longer presented to the client. The record below is kept for history and cannot be edited.' };
  } else if (!historical && !ready) {
    banner = { tone: 'warn', title: 'Not ready to submit', body: `${missing.length} required item${missing.length === 1 ? ' needs' : 's need'} attention: ${missing.map((m) => m.label).join(', ')}.` };
  } else if (!historical && readyButViewOnly) {
    banner = { tone: 'info', title: 'All requirements complete', body: 'This submittal is ready to be recorded with the client by the requisition team.' };
  } else if (!historical && ready) {
    banner = { tone: 'ok', title: 'All requirements complete', body: 'This submittal is ready to be recorded with the client. Recording it freezes the résumé and client rate shown here.' };
  }

  const scrollPrep = () => prepRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <section className="sw-root">
      <nav className="sw-breadcrumb" aria-label="Breadcrumb">
        <Link to="/requisitions">Requisitions</Link>
        <span aria-hidden="true">/</span>
        <Link to={`/requisitions/${identity.requisition.id}`}>
          {identity.requisition.id}{role ? ` · ${role}` : ''}
        </Link>
        <span aria-hidden="true">/</span>
        <span className="sw-breadcrumb__here">Submittal · {who}</span>
      </nav>

      <Card className="sw-head">
        <span className="sw-avatar" aria-hidden="true">{initialsOf(who)}</span>
        <div className="sw-head__id">
          <div className="sw-head__titlerow">
            <h1 className="sw-head__name">{who}</h1>
            <StatusPill tone={pill.tone} dot>{pill.label}</StatusPill>
            {submittedFamily && cPill ? (
              <StatusPill tone={cPill.tone}>Client: {cPill.label}</StatusPill>
            ) : null}
          </div>
          <div className="sw-head__sub">
            {role ?? 'Role'} · <b>{client ?? 'Client'}</b> · <span className="sw-mono">{identity.requisition.id}</span>
          </div>
          <div className={`sw-head__next sw-head__next--${banner?.tone ?? 'muted'}`}>{headLine}</div>
          <div className="sw-head__meta">
            Recruiting stage: {pipeline.current_stage ?? '—'} · Recruiter {context.recruiter?.name ?? '—'} · Account manager {context.owner?.name ?? '—'}
          </div>
        </div>
        <div className="sw-head__actions">
          <Link className="sw-btn sw-btn--secondary" to={`/talent/${identity.talent.id}`}>
            Open Talent 360
          </Link>
          {canRecord ? (
            <Button type="button" onClick={() => setModalOpen(true)}>Record submittal</Button>
          ) : null}
          {reviewBlockers ? (
            <Button type="button" onClick={scrollPrep}>
              {missing.length === 1 ? 'Review blocker' : 'Review blockers'}
            </Button>
          ) : null}
          {readyButViewOnly ? (
            <span className="sw-viewonly">View only · submitting is done by the requisition team</span>
          ) : null}
        </div>
      </Card>

      {banner !== null ? (
        <div className={`sw-banner sw-banner--${banner.tone}`} role="status">
          <span className="sw-banner__mark" aria-hidden="true">
            {banner.tone === 'ok' || banner.tone === 'info' ? '✓' : banner.tone === 'neutral' ? '–' : '!'}
          </span>
          <div className="sw-banner__body">
            <b>{banner.title}</b>
            <span>{banner.body}</span>
          </div>
          {banner.action ? (
            <Button variant="secondary" type="button" onClick={banner.action.onClick}>
              {banner.action.label}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="sw-grid">
        <div className="sw-main">
          <Card flush className="sw-prep" >
            <div ref={prepRef} />
            <div className="sw-prep__head">
              <span className="sw-prep__title">
                {historical ? 'Preparation · completed before handoff' : 'Preparation'}
              </span>
              {!historical ? (
                <span className="sw-prep__count">{counts.done} of {counts.total} complete</span>
              ) : null}
              <span className="sw-prep__note">{historical ? 'Read-only' : 'Checked by Aramo · updates live'}</span>
            </div>
            {readiness.requirements.map((req) => {
              const rv = requirementRow(req, historical);
              const focused = focus !== null && req.key === focus;
              return (
                <div key={req.key} className={`sw-req sw-req--${rv.tint}${focused ? ' sw-req--focus' : ''}`}>
                  <span className={`sw-req__mark sw-req__mark--${rv.tint}`} aria-hidden="true">{rv.mark}</span>
                  <div className="sw-req__body">
                    <div className="sw-req__labelrow">
                      <b>{req.label}</b>
                      <span className={`sw-req__status sw-req__status--${rv.statusTone}`}>{rv.statusText}</span>
                    </div>
                    {!req.satisfied && req.reason !== null ? (
                      <span className="sw-req__detail">{req.reason}</span>
                    ) : null}
                    {!req.satisfied && req.remediation !== null ? (
                      <span className="sw-req__remediation">{req.remediation}</span>
                    ) : null}
                    <span className="sw-req__source">{req.source.replace(/_/g, ' ')}</span>
                  </div>
                  {remediationOnRequisition(req) ? (
                    <Link className="sw-req__action" to={`/requisitions/${identity.requisition.id}`}>
                      Open requisition
                    </Link>
                  ) : null}
                </div>
              );
            })}
          </Card>

          {/* SW-6 — the post-handoff client-response experience (ClientSelection
              authority): state, waiting-duration, feedback, governed outcome actions,
              interview summary + deep-link, history. Rendered once a submittal has been
              handed to the client (historical). */}
          {historical ? (
            <ClientResponseSection view={model} onChanged={() => void load()} />
          ) : null}

          <Card className="sw-eng">
            <div className="sw-eng__head">
              <span className="sw-eng__title">Recruiting engagement</span>
              <span className="sw-eng__ctx">For context · Preparation above decides readiness</span>
            </div>
            <div className="sw-eng__verdict">
              {engagementSummary(engagement)}
            </div>
          </Card>
        </div>

        <div className="sw-rail">
          {submittedFamily || revoked ? (
            <Card className="sw-rec">
              <div className="sw-rec__title">Submittal record</div>
              {recordRows(delivery, submittedBillLabel).map((r) => (
                <div key={r.k} className="sw-rec__row">
                  <span className="sw-rec__k">{r.k}</span>
                  <span className="sw-rec__v">{r.v}</span>
                </div>
              ))}
              <div className="sw-rec__foot">Recorded once at handoff · cannot be edited</div>
            </Card>
          ) : null}

          {commercial !== null ? (
            <Card className="sw-com">
              <div className="sw-com__title">Commercial</div>
              {historical ? (
                <>
                  <ComRow k="Submitted client rate" v={submittedBillLabel ?? '—'} note={delivery.submitted_at ? `Frozen at handoff ${formatDate(delivery.submitted_at)}` : null} />
                  {submittedBillLabel !== null && liveBillLabel !== null && liveBillLabel !== submittedBillLabel ? (
                    <ComRow k="Current requisition rate" v={liveBillLabel} note="The submitted rate does not change" muted />
                  ) : null}
                </>
              ) : (
                <ComRow k="Client bill rate" v={liveBillLabel ?? 'Not set'} note={null} warn={liveBillLabel === null} />
              )}
            </Card>
          ) : null}

          <Card className="sw-reqctx">
            <div className="sw-reqctx__title">Requisition</div>
            <div className="sw-rec__row"><span className="sw-rec__k">Client</span><span className="sw-rec__v">{client ?? '—'}</span></div>
            <div className="sw-rec__row"><span className="sw-rec__k">Talent location</span><span className="sw-rec__v">{context.talent_location ?? '—'}</span></div>
            <div className="sw-rec__row"><span className="sw-rec__k">Work authorization</span><span className="sw-rec__v">{context.work_authorization ?? '—'}</span></div>
            <div className="sw-rec__row"><span className="sw-rec__k">Recruiter</span><span className="sw-rec__v">{context.recruiter?.name ?? '—'}</span></div>
            <div className="sw-rec__row"><span className="sw-rec__k">Account manager</span><span className="sw-rec__v">{context.owner?.name ?? '—'}</span></div>
            <Link className="sw-link" to={`/requisitions/${identity.requisition.id}`}>Back to requisition →</Link>
          </Card>
        </div>
      </div>

      {submittalId !== null ? (
        <RecordSubmittalDialog
          open={modalOpen}
          onOpenChange={setModalOpen}
          submittalId={submittalId}
          who={who}
          role={role}
          client={client}
          resumeLabel={null}
          billRateLabel={liveBillLabel}
          onRecorded={() => void load()}
          onRaceConflict={() => { setRaceConflict(true); void load(); }}
        />
      ) : null}
    </section>
  );
}

function ComRow({ k, v, note, muted, warn }: { k: string; v: string; note: string | null; muted?: boolean; warn?: boolean }) {
  return (
    <div className="sw-com__row">
      <span className="sw-com__line">
        <span className="sw-rec__k">{k}</span>
        <span className={`sw-com__v${muted ? ' sw-com__v--muted' : ''}${warn ? ' sw-com__v--warn' : ''}`}>{v}</span>
      </span>
      {note !== null ? <span className="sw-com__note">{note}</span> : null}
    </div>
  );
}

// Engagement CONTEXT summary — rendered from the SW-4 verdict ONLY. It never shows
// "Complete" when readiness reports engagement unavailable/blocking (§16): the words
// below track the verdict's own `satisfied`/`unavailable`/`governed` flags.
function engagementSummary(e: WorkspaceView['engagement']): string {
  if (e.unavailable) return 'Engagement policy applies; per-talent evidence is not resolved in this read.';
  if (!e.governed) return 'No engagement policy applies to this client.';
  if (e.satisfied) return 'Recruiting engagement evidence is on record for this client.';
  return 'Recruiting engagement evidence is required and not yet complete.';
}

function recordRows(delivery: WorkspaceView['delivery'], submittedBillLabel: string | null): { k: string; v: string }[] {
  const rows: { k: string; v: string }[] = [
    { k: 'Submitted', v: formatDateTime(delivery.submitted_at) },
    { k: 'Delivery', v: deliveryLabel(delivery.delivery_channel) },
    { k: 'External reference', v: delivery.external_reference ?? 'None recorded' },
  ];
  if (submittedBillLabel !== null) rows.push({ k: 'Client rate submitted', v: submittedBillLabel });
  return rows;
}
