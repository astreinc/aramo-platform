import type { TalentRequisitionJourney } from '../pipeline/talent-journey-api';

// Offer & Start — pure, SERVER-FACT-DRIVEN step derivation. The FE never decides a transition
// and holds no completion flags (§2.4): every step's status is read from authoritative server
// state (client-selection, offer, the offer-letter DOCUMENT signal, placement). "Document
// signed" (offer_document EXECUTED) and "offer accepted" (offer_state ACCEPTED) are kept
// DISTINCT (§2.5). Internal approval is OMITTED entirely — no real approval authority is bound
// to offer send today (§6.2 typed GAP); it is never faked as a Task or an FE step.

export type StepStatus = 'done' | 'current' | 'future' | 'declined';
export type Engagement = 'CONTRACT' | 'DIRECT_HIRE';

export interface JourneyStep {
  readonly key: string;
  readonly label: string;
  readonly group: 'Offer & Acceptance' | 'Pre-start Readiness' | 'Start & Placement';
  readonly status: StepStatus;
}

const SENTISH = new Set(['SENT', 'NEGOTIATION', 'ACCEPTED']);

interface Milestone {
  readonly key: string;
  readonly label: string;
  readonly group: JourneyStep['group'];
  readonly reached: boolean;
}

export function deriveSteps(
  journey: TalentRequisitionJourney,
  engagement: Engagement = 'CONTRACT',
): readonly JourneyStep[] {
  const s = journey.sub_states;
  const selection = s['selection_state'] ?? null;
  const offer = s['offer_state'] ?? null;
  const doc = journey.offer_document?.status ?? null;
  const placement = s['placement_state'] ?? null;
  const declined = offer === 'DECLINED';
  const hasPlacement = placement !== null;

  const clientSelected = selection === 'SELECTED' || offer !== null || hasPlacement;
  const offerPrepared = offer !== null || doc !== null || hasPlacement;
  const sent = (offer !== null && SENTISH.has(offer)) || doc === 'AWAITING_SIGNATURE' || doc === 'EXECUTED' || hasPlacement;
  const signedAndAccepted = (doc === 'EXECUTED' && (offer === 'ACCEPTED' || hasPlacement)) || hasPlacement;
  const preStart = hasPlacement;
  const ready = placement === 'READY_TO_START' || placement === 'STARTED';
  const started = placement === 'STARTED';

  const dh = engagement === 'DIRECT_HIRE';
  const milestones: Milestone[] = [
    { key: 'client_selected', label: 'Client selected', group: 'Offer & Acceptance', reached: clientSelected },
    { key: 'offer_prepared', label: 'Offer prepared', group: 'Offer & Acceptance', reached: offerPrepared },
    { key: 'sent', label: 'Sent to talent', group: 'Offer & Acceptance', reached: sent },
    { key: 'signed_accepted', label: 'Document signed + offer accepted', group: 'Offer & Acceptance', reached: signedAndAccepted },
    { key: 'pre_start', label: 'Pre-start requirements', group: 'Pre-start Readiness', reached: preStart },
    { key: 'ready', label: 'Ready to start', group: 'Pre-start Readiness', reached: ready },
    {
      // Contract assignment materializes as part of the authoritative STARTED transition
      // (§8.2 — no standalone "create assignment" command); so this completes with STARTED.
      key: 'assignment',
      label: dh ? 'Start confirmed' : 'Assignment created',
      group: 'Start & Placement',
      reached: started,
    },
    {
      key: 'started',
      label: dh ? 'Placement' : 'Started · active assignment',
      group: 'Start & Placement',
      reached: started,
    },
  ];

  const firstIncomplete = milestones.findIndex((m) => !m.reached);
  return milestones.map((m, i) => {
    // Declined closes the offer at the signed/accepted step — the journey is read-only there.
    if (declined && m.key === 'signed_accepted') return { ...m, status: 'declined' as const };
    if (declined && i > 3) return { ...m, status: 'future' as const };
    const status: StepStatus =
      firstIncomplete === -1 ? 'done' : i < firstIncomplete ? 'done' : i === firstIncomplete ? 'current' : 'future';
    return { key: m.key, label: m.label, group: m.group, status };
  });
}

// Needs-attention EXCEPTIONS are the canonical server-derived offer-start exceptions
// (TalentRequisitionJourney.offer_start_exceptions, from libs/placement
// deriveOfferStartExceptions) — the FE renders them and no longer re-derives the
// offer/placement predicates here.
