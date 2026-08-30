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

// The composed journey for one (tenant, requisition, talent) episode.
export interface TalentRequisitionJourney {
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly current_journey_stage: JourneyStageName;
  readonly stages: readonly JourneyStageElement[];
  readonly sub_states: JourneySubStates;
  readonly actions: readonly JourneyAction[];
}
