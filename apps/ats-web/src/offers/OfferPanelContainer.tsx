import { useCallback, useEffect, useState } from 'react';

import { findSubmittalForTalentJob } from '../submittals/submittals-api';

import { OfferPanel } from './OfferPanel';
import type { OfferAffordance } from './offer-affordance';
import { createOffer, listOffers, transitionOffer } from './offers-api';
import type { OfferState, OfferView } from './types';

// Offer Lifecycle (D7 — LOCKED Aramo-Offer-D7-OfferPanel-Wiring v1.0). The smart
// container that wires the presentational OfferPanel to the governed /v1/offers
// surface. Given a pipeline row's (requisition_id, talent_record_id):
//   - DISCOVER the current offer (R-DISCOVERY: GET /v1/offers filter),
//   - render its affordances + drive PATCH transitions (offer:transition),
//   - or, when no live offer exists, CREATE one (R-CREATE-BRIDGE: resolve
//     submittal_id via the submittals lookup, then POST — offer:create).
// The BE guards + ADR-0024 policy + DB trigger are the authority; FE gating is
// UX only.

// The still-actionable (non-terminal) states — FE mirror of the BE OFFER
// position OPEN set (offer-lifecycle.ts OFFER_STATE_POSITION). ACCEPTED and the
// CLOSED set are terminal (no outgoing edge), so a fresh offer may be created.
const OPEN_OFFER_STATES: ReadonlySet<OfferState> = new Set([
  'DRAFT',
  'SENT',
  'NEGOTIATION',
]);

// The CLOSED-unsuccessful terminals (BE OFFER_STATE_POSITION 'CLOSED'). After one
// of these a fresh offer may be created (the one-live trigger only blocks a
// second NON-terminal offer). ACCEPTED is terminal-success → no re-create (the
// flow proceeds to placement).
const CLOSED_UNSUCCESSFUL_STATES: ReadonlySet<OfferState> = new Set([
  'DECLINED',
  'EXPIRED',
  'RESCINDED',
]);

const OFFER_CREATE = 'offer:create'; // read rides create-authority this slice

export interface OfferPanelContainerProps {
  readonly requisitionId: string;
  readonly talentRecordId: string;
  readonly scopes: readonly string[];
}

export function OfferPanelContainer({
  requisitionId,
  talentRecordId,
  scopes,
}: OfferPanelContainerProps): JSX.Element {
  const [offer, setOffer] = useState<OfferView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canRead = scopes.includes(OFFER_CREATE);
  const canCreate = scopes.includes(OFFER_CREATE);

  const load = useCallback(async (): Promise<void> => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const { items } = await listOffers({ requisitionId, talentRecordId });
      // Prefer the live (non-terminal) offer; else the most recent for context.
      const live = items.find((o) => OPEN_OFFER_STATES.has(o.state));
      setOffer(live ?? items[0] ?? null);
    } catch {
      setErr('Could not load the offer.');
    } finally {
      setLoading(false);
    }
  }, [canRead, requisitionId, talentRecordId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onAction = useCallback(
    async (a: OfferAffordance): Promise<void> => {
      if (offer === null || busy) return;
      setBusy(true);
      setErr(null);
      try {
        const updated = await transitionOffer(offer.id, { to_state: a.toState });
        setOffer(updated);
      } catch {
        setErr(`Could not ${a.label.toLowerCase()} the offer.`);
      } finally {
        setBusy(false);
      }
    },
    [offer, busy],
  );

  const onCreate = useCallback(async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const { submittal } = await findSubmittalForTalentJob(
        talentRecordId,
        requisitionId,
      );
      if (submittal === null) {
        setErr('No submittal yet — submit this talent before making an offer.');
        return;
      }
      const created = await createOffer({
        submittal_id: submittal.id,
        requisition_id: requisitionId,
        talent_record_id: talentRecordId,
      });
      setOffer(created);
    } catch {
      setErr('Could not create the offer.');
    } finally {
      setBusy(false);
    }
  }, [busy, requisitionId, talentRecordId]);

  if (!canRead) return <></>;
  if (loading) {
    return (
      <section className="rc-offer rc-offer--loading">Loading offer…</section>
    );
  }

  // Create is offered only when there is no offer at all, or the last one is a
  // CLOSED-unsuccessful terminal — never while one is live, never after ACCEPTED.
  const showCreate =
    canCreate &&
    (offer === null || CLOSED_UNSUCCESSFUL_STATES.has(offer.state));

  return (
    <section className="rc-offerwrap">
      {offer !== null ? (
        <OfferPanel state={offer.state} scopes={scopes} onAction={onAction} />
      ) : null}
      {showCreate ? (
        <button
          type="button"
          className="rc-hbtn rc-hbtn--primary"
          disabled={busy}
          onClick={() => void onCreate()}
        >
          Make offer
        </button>
      ) : null}
      {err ? <p className="rc-offer__err">{err}</p> : null}
    </section>
  );
}
