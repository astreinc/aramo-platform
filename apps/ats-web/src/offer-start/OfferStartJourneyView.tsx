import { useCallback, useEffect, useState } from 'react';
import { Button } from '@aramo/fe-foundation';
import { Link, useParams } from 'react-router-dom';

import { remindOfferDocument, requestOfferDocument, sendOfferDocument } from '../offer-document/offer-document-api';
import { markPlacementReady } from '../pre-start/pre-start-api';
import { getTalentJourney, type TalentRequisitionJourney } from '../pipeline/talent-journey-api';
import { listOffers } from '../offers/offers-api';
import type { OfferView } from '../offers/types';

import { deriveSteps, deriveExceptions, type JourneyStep } from './offer-start-steps';
import './offer-start.css';

// Offer & Start journey page (directive §6.3) — ONE person × requisition surface keyed on the
// pipeline episode. PROJECTION/ORCHESTRATION ONLY: it reads authoritative server facts (the
// composed journey + the offer) and holds NO offer/pre-start/placement state of its own. The
// stepper, pill, counts and Needs-attention are all derived from server state (§2.4); actions
// (boundary 3) route to each owning domain's existing command.

// The header pill LABELS the server-derived journey position — presentation only, never a
// second status. Offer accepted and document signed stay distinct (§2.5).
function pillLabel(j: TalentRequisitionJourney): string {
  const offer = j.sub_states['offer_state'];
  const placement = j.sub_states['placement_state'];
  if (placement === 'STARTED') return 'Started';
  if (placement === 'READY_TO_START') return 'Ready to start';
  if (placement === 'BLOCKED') return 'Pre-start blocked';
  if (placement !== null && placement !== undefined) return 'Pre-start';
  if (offer === 'ACCEPTED') return 'Offer accepted';
  if (offer === 'DECLINED') return 'Offer declined';
  if (offer === 'EXPIRED') return 'Offer expired';
  if (j.offer_document?.status === 'AWAITING_SIGNATURE') return 'Awaiting signature';
  if (offer === 'SENT' || offer === 'NEGOTIATION') return 'Offer sent';
  if (offer === 'DRAFT' || j.offer_document !== null) return 'Offer prepared';
  if (j.sub_states['selection_state'] === 'SELECTED') return 'Client selected';
  return j.current_journey_stage;
}

function pickOffer(offers: readonly OfferView[]): OfferView | null {
  if (offers.length === 0) return null;
  const open = offers.find((o) => o.state === 'SENT' || o.state === 'NEGOTIATION' || o.state === 'ACCEPTED' || o.state === 'DRAFT');
  return open ?? offers[0]!;
}

const DOC_STATUS_LABEL: Record<string, string> = {
  REQUESTED: 'Requested',
  AWAITING_SIGNATURE: 'Awaiting signature',
  EXECUTED: 'Signed',
};

export function OfferStartJourneyView(): JSX.Element {
  const { pipelineId } = useParams<{ pipelineId: string }>();
  const [journey, setJourney] = useState<TalentRequisitionJourney | null>(null);
  const [offer, setOffer] = useState<OfferView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendModalOpen, setSendModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (pipelineId === undefined) return;
    setLoading(true);
    setError(null);
    try {
      const j = await getTalentJourney(pipelineId);
      setJourney(j);
      // Offer terms (§6.4) — a SEPARATE authoritative read; talent-facing fields only, read-only.
      try {
        const { items } = await listOffers({ requisitionId: j.requisition_id, talentRecordId: j.talent_record_id });
        setOffer(pickOffer(items));
      } catch {
        setOffer(null); // terms are supplementary — absence must not blank the journey.
      }
    } catch {
      setError('Could not load this Offer & Start journey.');
    } finally {
      setLoading(false);
    }
  }, [pipelineId]);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = useCallback((msg: string): void => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  // Every current-step action routes to an owning-domain GOVERNED command (never an FE state
  // write). The recipient + signing link stay server-resolved (§15.4 / PL-2 / PL-5).
  const runAction = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch {
      setActionError('That action could not be completed. Refresh and try again.');
    } finally {
      setBusy(false);
    }
  }, []);

  if (loading) {
    return <section className="os-root"><div className="os-empty">Loading…</div></section>;
  }
  if (error !== null || journey === null) {
    return <section className="os-root"><div className="os-empty">{error ?? 'Not found.'}</div></section>;
  }

  // §8 — the engagement branch is the authoritative placement kind (DIRECT_HIRE ⇔ PERMANENT);
  // it diverges the Start & Placement labels + the completion banner. Absent placement ⇒ CONTRACT default.
  const engagement = journey.placement?.kind === 'PERMANENT' ? 'DIRECT_HIRE' : 'CONTRACT';
  const steps = deriveSteps(journey, engagement);
  const exceptions = deriveExceptions(journey);
  const doneCount = steps.filter((s) => s.status === 'done').length;

  // §8.4 — the completion banner is PRESENTATION only, derived from the authoritative placement
  // state (never a stored journey-completion flag). §8.2/§8.5: the commercial-bearing STARTED
  // transition stays with the owning placement surface — the journey deep-links, never reimplements
  // it (no governed inline start affordance exists today — a typed GAP, not faked here).
  const placementState = journey.sub_states['placement_state'] ?? null;
  const completionBanner =
    placementState === 'STARTED'
      ? (engagement === 'DIRECT_HIRE' ? 'Placement recorded' : 'Started · active assignment')
      : null;

  const grouped: { group: string; steps: JourneyStep[] }[] = [];
  for (const s of steps) {
    const g = grouped.find((x) => x.group === s.group);
    if (g) g.steps.push(s);
    else grouped.push({ group: s.group, steps: [s] });
  }

  // Current-step action — derived from server state; each routes to a governed owning-domain
  // command (offer-letter prepare/send/remind). Declined ⇒ read-only (no action; §6.8).
  const doc = journey.offer_document;
  const declined = journey.sub_states['offer_state'] === 'DECLINED';
  type StepAction = { readonly key: string; readonly label: string; readonly run: () => void };
  let stepAction: StepAction | null = null;
  if (!declined) {
    if (offer !== null && doc === null) {
      stepAction = {
        key: 'prepare',
        label: 'Prepare offer letter',
        run: () =>
          void runAction(async () => {
            await requestOfferDocument({ offer_id: offer.id });
            await load();
            flash('Offer letter prepared');
          }),
      };
    } else if (doc?.status === 'REQUESTED') {
      stepAction = { key: 'send', label: 'Review & send', run: () => setSendModalOpen(true) };
    } else if (doc?.status === 'AWAITING_SIGNATURE') {
      stepAction = {
        key: 'remind',
        label: 'Send reminder',
        run: () =>
          void runAction(async () => {
            await remindOfferDocument(doc.document_id);
            flash('Reminder sent');
          }),
      };
    }
  }
  const onConfirmSend = (): void => {
    if (offer === null || doc === null) return;
    void runAction(async () => {
      await sendOfferDocument(doc.document_id, offer.id);
      setSendModalOpen(false);
      await load();
      flash('Offer sent for signature');
    });
  };

  // §7.5 — the governed Ready-to-start transition. Fail-closed at the server (it re-checks the
  // authoritative readiness assessment); the FE never derives readiness nor transitions optimistically
  // — it calls markReadyToStart and reloads the composed journey. Rendered ONLY when the server's
  // `ready_to_start_action` is present (i.e. the authority already says ready).
  const preStart = journey.pre_start ?? null;
  const attnReqs = preStart?.needs_attention ?? [];
  // When the authoritative pre-start section is present, its specific FAILED-requirement rows
  // supersede the coarse placement-BLOCKED exception (no redundant signal; §7.6).
  const shownExceptions = preStart !== null ? exceptions.filter((e) => e.key !== 'pre_start_blocked') : exceptions;
  const onMarkReady = (): void => {
    if (preStart === null) return;
    void runAction(async () => {
      await markPlacementReady(preStart.placement_process_id);
      await load();
      flash('Marked ready to start');
    });
  };
  const PRE_START_STATUS_LABEL: Record<string, string> = {
    PENDING: 'Pending', IN_PROGRESS: 'In progress', SATISFIED: 'Satisfied',
    VERIFIED: 'Verified', WAIVED: 'Waived', FAILED: 'Failed', CANCELED: 'Canceled',
  };

  return (
    <section className="os-root" data-testid="offer-start-journey">
      <nav className="os-breadcrumb">
        <Link to="/requisitions">Requisitions</Link>
        <span>/</span>
        <Link to={`/requisitions/${journey.requisition_id}`}>Requisition</Link>
        <span>/</span>
        <span className="os-breadcrumb-current">Offer &amp; Start</span>
      </nav>

      <header className="os-header">
        <div className="os-header-main">
          <h1 className="os-title">Offer &amp; Start</h1>
          <span className="os-pill" data-testid="os-pill">{pillLabel(journey)}</span>
          <span className="os-progress">{doneCount} of {steps.length} complete</span>
        </div>
        <Link className="os-link" to={`/talent/${journey.talent_record_id}`}>Open Talent 360</Link>
      </header>

      <div className="os-body">
        <div className="os-main">
          {completionBanner !== null ? (
            <div className="os-banner" data-testid="os-completion-banner">
              <span className="os-banner-mark" aria-hidden="true">✓</span>
              <span className="os-banner-text">{completionBanner}</span>
            </div>
          ) : null}
          {/* §8.2/§8.5 — Ready to start: the governed start (with its commercial terms) is owned
              by the placement surface; the journey deep-links there, it does not reimplement start. */}
          {placementState === 'READY_TO_START' && journey.placement !== null ? (
            <div className="os-card os-step-actions" data-testid="os-start">
              <div className="os-card-head">Ready to start</div>
              <div className="os-muted">
                {engagement === 'DIRECT_HIRE'
                  ? 'Requirements are met. Confirm the placement in the placement record (where the start terms are captured).'
                  : 'Requirements are met. Start the assignment in the placement record (where the commercial terms are captured).'}
              </div>
              <Link className="os-link" to={`/placements/${journey.placement.id}`} data-testid="os-start-link">
                {engagement === 'DIRECT_HIRE' ? 'Confirm placement →' : 'Start assignment →'}
              </Link>
            </div>
          ) : null}
          {(stepAction !== null || declined) && (
            <div className="os-card os-step-actions" data-testid="os-actions">
              <div className="os-card-head">This step</div>
              {declined ? (
                <div className="os-muted">The offer was declined — this journey is read-only here. The requisition and client selection keep their own state.</div>
              ) : stepAction !== null ? (
                <Button type="button" onClick={stepAction.run} disabled={busy} data-testid={`os-action-${stepAction.key}`}>
                  {stepAction.label}
                </Button>
              ) : null}
              {actionError !== null ? <div className="os-action-error" role="alert">{actionError}</div> : null}
            </div>
          )}
          <div className="os-stepper" data-testid="os-stepper">
          {grouped.map((g) => (
            <div key={g.group} className="os-group">
              <div className="os-group-head">{g.group}</div>
              {g.steps.map((s) => (
                <div key={s.key} className={`os-step os-step--${s.status}`} data-testid={`os-step-${s.key}`}>
                  <span className="os-step-mark" aria-hidden="true">
                    {s.status === 'done' ? '✓' : s.status === 'declined' ? '✕' : s.status === 'current' ? '●' : '○'}
                  </span>
                  <span className="os-step-label">{s.label}</span>
                  <span className="os-step-status">{s.status}</span>
                </div>
              ))}
            </div>
          ))}
          </div>

          {/* §7 Pre-start Readiness — generic over authoritative requirement rows (§7.2); N-of-M
              is display-only (§7.4); the Ready-to-start button appears ONLY when the server says
              ready (§7.5, fail-closed). Remediation deep-links to the governed onboarding workspace —
              the journey never reimplements the satisfy/verify/waive/evidence flow (§7.8). */}
          {preStart !== null ? (
            <div className="os-card os-prestart" data-testid="os-prestart">
              <div className="os-card-head">
                Pre-start readiness
                <span className="os-progress" data-testid="os-prestart-count">
                  {preStart.summary.complete} of {preStart.summary.total} complete
                </span>
              </div>
              {preStart.requirements.length === 0 ? (
                <div className="os-muted">
                  {preStart.readiness.materialized ? 'No pre-start requirements for this placement.' : 'Pre-start requirements are being prepared.'}
                </div>
              ) : (
                preStart.requirements.map((r) => (
                  <div key={r.id} className="os-req" data-testid={`os-req-${r.id}`}>
                    <span className="os-req-label">{r.label}{r.blocking ? <span className="os-req-blocking" title="Blocking">•</span> : null}</span>
                    <span className="os-req-status" data-testid={`os-req-status-${r.id}`}>{PRE_START_STATUS_LABEL[r.status] ?? r.status}</span>
                    {r.owner_role !== null ? <span className="os-muted os-req-owner">{r.owner_role}</span> : null}
                  </div>
                ))
              )}
              <div className="os-prestart-foot">
                {preStart.ready_to_start_action !== null ? (
                  <Button type="button" onClick={onMarkReady} disabled={busy} data-testid="os-action-mark-ready">
                    {preStart.ready_to_start_action.action}
                  </Button>
                ) : null}
                <Link className="os-link" to={`/onboarding/${preStart.placement_process_id}`} data-testid="os-prestart-workspace">
                  Open onboarding workspace →
                </Link>
              </div>
            </div>
          ) : null}
        </div>

        <aside className="os-rail">
          <div className="os-card" data-testid="os-needs-attention">
            <div className="os-card-head">Needs attention{shownExceptions.length + attnReqs.length > 0 ? <span className="os-badge">{shownExceptions.length + attnReqs.length}</span> : null}</div>
            {shownExceptions.length + attnReqs.length === 0 ? (
              <div className="os-muted">Everything on track. Aramo moves the ordinary steps; exceptions show here.</div>
            ) : (
              <>
                {shownExceptions.map((e) => (
                  <div key={e.key} className="os-attn" data-testid={`os-attn-${e.key}`}>
                    <span className="os-attn-what">{e.label}</span>
                    <span className="os-muted">{e.detail}</span>
                  </div>
                ))}
                {/* §7.6 — authoritative FAILED-blocking requirements (server fact), each
                    deep-linking to the governed onboarding workspace to resolve. */}
                {attnReqs.map((r) => (
                  <div key={`req-${r.id}`} className="os-attn" data-testid={`os-attn-req-${r.id}`}>
                    <span className="os-attn-what">{r.label} failed</span>
                    <span className="os-muted">A required pre-start requirement failed — resolve it to continue.</span>
                    {preStart !== null ? (
                      <Link className="os-link" to={`/onboarding/${preStart.placement_process_id}`}>Resolve →</Link>
                    ) : null}
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="os-card" data-testid="os-documents">
            <div className="os-card-head">Documents</div>
            {journey.offer_document !== null ? (
              <div className="os-doc" data-testid="os-doc-offer-letter">
                <span className="os-doc-name">Offer Letter</span>
                <span className="os-doc-status">{DOC_STATUS_LABEL[journey.offer_document.status] ?? journey.offer_document.status}</span>
              </div>
            ) : (
              <div className="os-muted">No offer letter yet.</div>
            )}
          </div>

          <div className="os-card" data-testid="os-offer-terms">
            <div className="os-card-head">Offer terms <span className="os-muted">talent-facing</span></div>
            {offer !== null ? (
              <dl className="os-terms">
                <div><dt>Proposed start</dt><dd>{offer.proposed_start_date ?? '—'}</dd></div>
                <div><dt>Summary</dt><dd>{offer.offer_terms_summary ?? '—'}</dd></div>
                <div><dt>Expires</dt><dd>{offer.offer_expires_at ?? '—'}</dd></div>
              </dl>
            ) : (
              <div className="os-muted">No offer prepared yet.</div>
            )}
            <div className="os-commercial-note">Bill rate, margin and PO live in <Link to={`/requisitions/${journey.requisition_id}`}>Commercial →</Link></div>
          </div>

          <div className="os-card" data-testid="os-history">
            <div className="os-card-head">History</div>
            {journey.stages.filter((s) => s.occurred_at !== undefined).length === 0 ? (
              <div className="os-muted">No recorded events yet.</div>
            ) : (
              journey.stages
                .filter((s) => s.occurred_at !== undefined)
                .map((s) => (
                  <div key={`${s.stage}-${s.source_object_id}`} className="os-hist">
                    <span className="os-hist-what">{s.stage}</span>
                    <span className="os-muted">{s.owner}</span>
                  </div>
                ))
            )}
          </div>
        </aside>
      </div>

      {sendModalOpen ? (
        <div className="os-modal-backdrop" data-testid="os-send-modal">
          <div className="os-modal" role="dialog" aria-modal="true" aria-label="Send offer letter for signature">
            <div className="os-modal-head">Send offer letter for signature</div>
            <div className="os-modal-body">
              The Offer Letter will be sent to the talent (resolved from the offer, server-side) for
              e-signature through Aramo. Nothing sends until you confirm.
            </div>
            <div className="os-modal-actions">
              <Button type="button" unstyled onClick={() => setSendModalOpen(false)} disabled={busy}>Cancel</Button>
              <Button type="button" onClick={onConfirmSend} disabled={busy} data-testid="os-confirm-send">Send for signature</Button>
            </div>
          </div>
        </div>
      ) : null}

      {toast !== null ? <div className="os-toast" data-testid="os-toast">{toast}</div> : null}
    </section>
  );
}
