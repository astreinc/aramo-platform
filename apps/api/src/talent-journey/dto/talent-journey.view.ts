import type { PipelineView } from '@aramo/pipeline';
import type { TalentSubmittalRecordView } from '@aramo/submittal';
import type {
  ClientSelectionProcessView,
  InterviewSessionView,
} from '@aramo/client-selection';
import type {
  OfferView,
  PlacementProcessView,
  ContractAssignmentView,
  OfferStartException,
} from '@aramo/placement';
import type { InstanceView as PreStartInstanceView } from '@aramo/pre-start-requirement';

// Lane 2 / L2-H (v1.1) — the Unified Talent Journey read contract. Composed in apps/api
// (the ONLY layer allowed to know all owners); GET-only; zero writes. Every sub-state type
// is DERIVED from its owner's own View via indexed access (Rule D — imported from the owner,
// never restated as a local literal list). The journey funnel vocabulary + owner identifiers
// below are L2-H's OWN vocabulary (not an owner's lifecycle ontology), so they are defined
// here legitimately.

// The eight composed owners. Client Selection + Interview are the L2-F owners.
export type JourneyOwner =
  | 'pipeline'
  | 'submittal'
  | 'client-selection'
  | 'interview'
  | 'offer'
  | 'placement'
  | 'pre-start'
  | 'assignment';

// The UI funnel stages (directive §"UI funnel stages"). Each attributes to its OWNER.
export type JourneyStageName =
  | 'SOURCED'
  | 'CONTACTED'
  | 'ENGAGED'
  | 'QUALIFYING'
  | 'QUALIFIED'
  | 'SUBMITTED'
  | 'CLIENT_REVIEW'
  | 'INTERVIEW'
  | 'CLIENT_DECLINED'
  | 'OFFER'
  | 'ACCEPTED_PLACED'
  | 'PRE_START'
  | 'READY'
  | 'STARTED'
  | 'NOT_IN_CONSIDERATION'
  | 'COMPLETED';

// One journey stage, attributed to the owner aggregate + the exact owner row that
// establishes it. A stage with no backing owner row is NEVER emitted (AC-1).
export interface JourneyStageElement {
  readonly stage: JourneyStageName;
  readonly owner: JourneyOwner;
  readonly source_object_id: string;
  readonly occurred_at?: string;
}

// The per-owner sub-state — ONE value per owner, each typed to that owner's imported
// state field (Rule D). R3 (PO ruling): STATE ENUMS ONLY — NO commercial/compensation/
// financial field is ever composed here. `null` = the owner has no row on this lineage.
export interface JourneySubStates {
  readonly pipeline_stage: PipelineView['status'] | null;
  readonly submittal_state: TalentSubmittalRecordView['state'] | null;
  readonly selection_state: ClientSelectionProcessView['state'] | null;
  readonly interview_state: InterviewSessionView['state'] | null;
  readonly offer_state: OfferView['state'] | null;
  readonly placement_state: PlacementProcessView['state'] | null;
  readonly pre_start_state: PreStartInstanceView['status'] | null;
  readonly assignment_state: ContractAssignmentView['lifecycle_state'] | null;
}

// An owner-specific action affordance. It NAMES the owner's EXISTING command route; the
// journey endpoint itself issues zero writes. There is no generic status control (AC-5).
export interface JourneyAction {
  readonly action: string;
  readonly owner: JourneyOwner;
  readonly command_route: string;
}

// Offer & Start §6.7 — the offer-letter DOCUMENT signal, DB-derived from the governed
// Document.status (write-back authoritative via the e-sign execution path), composed ONLY
// when the caller opts in (keeps the shared Talent 360 hot read DB-only; see D-ARCH-1).
// Kept DISTINCT from the Offer business state: `sub_states.offer_state === 'ACCEPTED'` is
// the acceptance fact (Offer authority); THIS is document/e-sign progress (§2.5 — signed is
// not accepted). Fine-grained per-signer sent/viewed timestamps are a typed GAP: the
// SignatureProviderPort exposes signer status + completion/certificate, not those instants —
// surfaced as a residual, never fabricated in FE.
export interface JourneyOfferDocument {
  readonly owner: 'documents';
  readonly document_id: string;
  readonly status: 'REQUESTED' | 'AWAITING_SIGNATURE' | 'EXECUTED';
}

// Offer & Start §7.2 — one authoritative pre-start requirement row, projected generically
// from PreStartRequirementInstance (the owning authority). Every field is imported from the
// owner's InstanceView (Rule D) — the journey NEVER hardcodes completion state (§7.2) nor a
// requirement taxonomy. `requirement_type` is the source/type; `owner_role` the owning domain;
// `completed_at`/`evidence_reference` are detail the FE renders (presentation, not business
// truth). `remediation` names the owner's EXISTING governed status-move route when the row is
// actionable — never a generic control.
export interface JourneyPreStartRequirement {
  readonly id: string;
  readonly requirement_type: PreStartInstanceView['requirement_type'];
  readonly label: string;
  readonly status: PreStartInstanceView['status'];
  readonly blocking: boolean;
  readonly owner_role: string | null;
  readonly completed_at: string | null;
  readonly evidence_reference: string | null;
  readonly remediation: JourneyAction | null;
}

// Offer & Start §7 — the composed Pre-start Readiness section, present ONLY when the caller
// opts in AND a placement exists (there is no pre-start before a placement). `readiness` is the
// AUTHORITATIVE assessment (RequirementInstanceRepository.assessBlocking — never an FE/journey
// re-derivation, §7.5). `summary` is display-only N-of-M composed from the rows (§7.4 — never
// persisted). `needs_attention` carries ONLY authoritative blocker facts (deriveBlockers —
// FAILED blocking requirements, §7.6). `ready_to_start_action` names the governed markReadyToStart
// route and is present ONLY when the authority says ready (fail-closed; the journey issues no write).
export interface JourneyPreStart {
  // The owning placement episode id — the authoritative key for the onboarding workspace
  // deep-link + the governed ready route (so the FE never reconstructs it).
  readonly placement_process_id: string;
  readonly requirements: readonly JourneyPreStartRequirement[];
  readonly summary: { readonly complete: number; readonly total: number };
  readonly readiness: { readonly materialized: boolean; readonly ready: boolean };
  readonly needs_attention: readonly JourneyPreStartRequirement[];
  readonly ready_to_start_action: JourneyAction | null;
}

// Offer & Start §8 — the minimal placement identity the Start & Placement increment needs:
// the owning placement id (authoritative key for the owner deep-link — never reconstructed FE-side)
// and the engagement branch (`kind`). Persisted placement_kind is nullable; a legacy/kind-agnostic
// placement starts CONTRACT (domain rule), so NULL normalizes to CONTRACT here. This carries NO
// commercial/compensation field (R3) — the start transition's commercial terms stay with the owner.
export interface JourneyPlacement {
  readonly id: string;
  readonly kind: 'CONTRACT' | 'PERMANENT';
}

// The composed journey for one (tenant, requisition, talent) episode.
export interface TalentRequisitionJourney {
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly current_journey_stage: JourneyStageName;
  readonly stages: readonly JourneyStageElement[];
  readonly sub_states: JourneySubStates;
  // The canonical live offer-start EXCEPTIONS (offer expired/declined, pre-start
  // blocked) derived from the owner states — the SAME semantic the Offer & Start
  // worklist uses. Consumers render these; they never re-derive the predicates.
  readonly offer_start_exceptions: readonly OfferStartException[];
  readonly actions: readonly JourneyAction[];
  // null when the caller did not opt in OR no offer-letter document exists yet.
  readonly offer_document: JourneyOfferDocument | null;
  // §7 — null when the caller did not opt in OR there is no placement yet.
  readonly pre_start: JourneyPreStart | null;
  // §8 — null until a placement exists; always composed thereafter (zero extra read).
  readonly placement: JourneyPlacement | null;
}
