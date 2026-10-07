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

// Offer & Start §7.2 — one authoritative pre-start requirement row (generic over the owning
// domain). The FE renders label/status/detail/source/owner but NEVER decides completion (§7.2);
// `remediation` names the owner's existing governed route when actionable.
export interface JourneyPreStartRequirement {
  readonly id: string;
  readonly requirement_type: string;
  readonly label: string;
  readonly status: string;
  readonly blocking: boolean;
  readonly owner_role: string | null;
  readonly completed_at: string | null;
  readonly evidence_reference: string | null;
  readonly remediation: JourneyAction | null;
}

// Offer & Start §7 — the Pre-start Readiness section. `readiness` is the AUTHORITATIVE server
// assessment; the FE never derives a second readiness algorithm (§7.5). `summary` is display-only
// N-of-M. `ready_to_start_action` is present only when the server says ready (fail-closed).
export interface JourneyPreStart {
  readonly placement_process_id: string;
  readonly requirements: readonly JourneyPreStartRequirement[];
  readonly summary: { readonly complete: number; readonly total: number };
  readonly readiness: { readonly materialized: boolean; readonly ready: boolean };
  readonly needs_attention: readonly JourneyPreStartRequirement[];
  readonly ready_to_start_action: JourneyAction | null;
}

// Offer & Start §8 — the owning placement identity + engagement branch. The FE uses `id` for the
// owner deep-link (authoritative, never reconstructed) and `kind` to diverge the labels/banner.
export interface JourneyPlacement {
  readonly id: string;
  readonly kind: 'CONTRACT' | 'PERMANENT';
}

// Offer & Start — one canonical live exception on the offer→start journey (offer
// expired/declined, pre-start blocked), derived + labelled SERVER-side. The FE
// renders these; it never re-decides the offer/placement exception predicates.
export interface OfferStartException {
  readonly kind: 'offer_expired' | 'offer_declined' | 'pre_start_blocked';
  readonly label: string;
  readonly detail: string;
}

// Recruiting-Journey §14 — the canonical recruiting next-action availability, owned
// and derived by the backend. The FE RENDERS these; it NEVER re-derives eligibility
// from stage equality. This is the ONLY source of truth for which recruiting action a
// surface may offer.
export type RecruitingAvailableAction =
  | 'contact_talent'
  | 'record_talent_response'
  | 'start_qualifying'
  | 'mark_qualified';

export interface TalentRequisitionJourney {
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly current_journey_stage: string;
  readonly stages: readonly JourneyStageElement[];
  readonly sub_states: Readonly<Record<string, string | null>>;
  readonly offer_start_exceptions: readonly OfferStartException[];
  readonly actions: readonly JourneyAction[];
  readonly recruiting_available_actions: readonly RecruitingAvailableAction[];
  readonly offer_document: JourneyOfferDocument | null;
  readonly pre_start: JourneyPreStart | null;
  readonly placement: JourneyPlacement | null;
}

// GET /v1/pipelines/:id/journey — the composed journey for one pipeline episode. A non-visible
// / cross-tenant episode is concealed as 404 by the server (surfaced as a foundation ApiError).
export async function getTalentJourney(pipelineId: string): Promise<TalentRequisitionJourney> {
  return apiClient.get<TalentRequisitionJourney>(
    `/v1/pipelines/${encodeURIComponent(pipelineId)}/journey`,
  );
}
