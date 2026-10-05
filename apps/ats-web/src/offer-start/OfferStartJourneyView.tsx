import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

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

  if (loading) {
    return <section className="os-root"><div className="os-empty">Loading…</div></section>;
  }
  if (error !== null || journey === null) {
    return <section className="os-root"><div className="os-empty">{error ?? 'Not found.'}</div></section>;
  }

  const steps = deriveSteps(journey);
  const exceptions = deriveExceptions(journey);
  const doneCount = steps.filter((s) => s.status === 'done').length;

  const grouped: { group: string; steps: JourneyStep[] }[] = [];
  for (const s of steps) {
    const g = grouped.find((x) => x.group === s.group);
    if (g) g.steps.push(s);
    else grouped.push({ group: s.group, steps: [s] });
  }

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

        <aside className="os-rail">
          <div className="os-card" data-testid="os-needs-attention">
            <div className="os-card-head">Needs attention{exceptions.length > 0 ? <span className="os-badge">{exceptions.length}</span> : null}</div>
            {exceptions.length === 0 ? (
              <div className="os-muted">Everything on track. Aramo moves the ordinary steps; exceptions show here.</div>
            ) : (
              exceptions.map((e) => (
                <div key={e.key} className="os-attn" data-testid={`os-attn-${e.key}`}>
                  <span className="os-attn-what">{e.label}</span>
                  <span className="os-muted">{e.detail}</span>
                </div>
              ))
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
    </section>
  );
}
