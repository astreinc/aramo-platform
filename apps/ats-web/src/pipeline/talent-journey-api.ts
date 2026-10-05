import { apiClient } from '@aramo/fe-foundation';

// Lane 2 / L2-H — the Unified Talent Journey read client. The FE consumes the BE-composed
// owner-attributed stage as the SINGLE stage source; it does NOT re-derive offer/placement/
// decline labels locally (that FE derivation is a placement-BOARD concern only, never the
// journey funnel). Shape mirrors the apps/api TalentRequisitionJourney contract.

export type JourneyOwner =
  | 'pipeline'
  | 'submittal'
  | 'client-selection'
  | 'interview'
  | 'offer'
  | 'placement'
  | 'pre-start'
  | 'assignment';

export interface JourneyStageElement {
  readonly stage: string;
  readonly owner: JourneyOwner;
  readonly source_object_id: string;
  readonly occurred_at?: string;
}

export interface JourneyAction {
  readonly action: string;
  readonly owner: JourneyOwner;
  readonly command_route: string;
}

// Offer & Start §6.7 — the opt-in offer-letter DOCUMENT signal (DB-derived, write-back
// authoritative), DISTINCT from the Offer ACCEPTED business fact (§2.5). null on the Talent
// 360 embed (opt-out) and until an offer-letter exists. Fine-grained per-signer sent/viewed
// timestamps are a server-side typed GAP (not exposed by the signature port) — never faked here.
export interface JourneyOfferDocument {
  readonly owner: 'documents';
  readonly document_id: string;
  readonly status: 'REQUESTED' | 'AWAITING_SIGNATURE' | 'EXECUTED';
}

export interface TalentRequisitionJourney {
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly current_journey_stage: string;
  readonly stages: readonly JourneyStageElement[];
  readonly sub_states: Readonly<Record<string, string | null>>;
  readonly actions: readonly JourneyAction[];
  readonly offer_document: JourneyOfferDocument | null;
}

// GET /v1/pipelines/:id/journey — the composed journey for one pipeline episode. A non-visible
// / cross-tenant episode is concealed as 404 by the server (surfaced as a foundation ApiError).
export async function getTalentJourney(pipelineId: string): Promise<TalentRequisitionJourney> {
  return apiClient.get<TalentRequisitionJourney>(
    `/v1/pipelines/${encodeURIComponent(pipelineId)}/journey`,
  );
}
