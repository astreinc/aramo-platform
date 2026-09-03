import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';
import {
  PipelineRepository,
  ACTIVE_FLOW_STAGES,
  type PipelineView,
} from '@aramo/pipeline';
import { SubmittalRepository, type TalentSubmittalRecordView } from '@aramo/submittal';
import {
  ClientSelectionProcessRepository,
  InterviewSessionRepository,
  JourneyProjectionRepository,
  type ClientSelectionProcessView,
  type InterviewSessionView,
} from '@aramo/client-selection';
import {
  OfferRepository,
  PlacementRepository,
  OFFER_STATE_POSITION,
  STATE_POSITION as PLACEMENT_STATE_POSITION,
  type OfferView,
  type PlacementProcessView,
  type ContractAssignmentView,
} from '@aramo/placement';
import {
  RequirementInstanceRepository,
  isUnresolvedStatus,
  type InstanceView as PreStartInstanceView,
} from '@aramo/pre-start-requirement';

import type {
  JourneyStageElement,
  JourneyStageName,
  JourneySubStates,
  JourneyAction,
  TalentRequisitionJourney,
} from './dto/talent-journey.view.js';

// Lane 2 / L2-H (v1.1) — the Unified Talent Journey read-composer. apps/api is the ONLY
// layer allowed to know all owners (pipeline-talent-enrichment precedent). GET-only; issues
// ZERO writes. Composition is BATCH-not-loop and staged by lineage:
//   Pipeline episode (AUTHZ existence gate → 404 conceal) → (requisition_id, talent_record_id)
//     → Submittal (by grain) → submittal_id
//        → { ClientSelection, Offer, Placement } read concurrently
//           → { deriveJourneyStages + Interview | Pre-Start + Assignment } read concurrently
// Every stage is attributed to its OWNER + the owner row id (source_object_id); a stage with
// no backing owner row is never emitted. sub_states carry STATE ENUMS ONLY (R3 — no
// commercial/compensation field is ever composed). Owner state tuples/positions are IMPORTED
// (Rule D); the funnel vocabulary is L2-H's own.

// The forward funnel order — L2-H's OWN journey vocabulary (not an owner ontology). Terminals
// sit at their natural funnel position; `current_journey_stage` = the max-ordinal contribution.
const JOURNEY_STAGE_ORDER: readonly JourneyStageName[] = [
  'SOURCED',
  'CONTACTED',
  'ENGAGED',
  'QUALIFYING',
  'QUALIFIED',
  'SUBMITTED',
  'CLIENT_REVIEW',
  'INTERVIEW',
  'CLIENT_DECLINED',
  'OFFER',
  'ACCEPTED_PLACED',
  'PRE_START',
  'READY',
  'STARTED',
  'COMPLETED',
  'NOT_IN_CONSIDERATION',
];
const stageOrdinal = (s: JourneyStageName): number => JOURNEY_STAGE_ORDER.indexOf(s);

// Pipeline status → the Pipeline-OWNED journey stage. The Pipeline owns exactly the five
// active-flow stages + the two canonical terminals; the interview / offer / placement /
// decline truths are owned by downstream aggregates (DDR §4 / SB-3 wall) and are NEVER
// derived from a Pipeline value — the composer reads them from their owners.
function pipelineOwnedStage(status: PipelineView['status']): JourneyStageName | null {
  switch (status) {
    case 'no_contact':
      return 'SOURCED';
    case 'contacted':
      return 'CONTACTED';
    case 'talent_responded':
      return 'ENGAGED';
    case 'qualifying':
      return 'QUALIFYING';
    case 'qualified':
      return 'QUALIFIED';
    case 'completed':
      return 'COMPLETED';
    case 'not_in_consideration':
      return 'NOT_IN_CONSIDERATION';
    default: {
      // Exhaustive over the canonical 7-state enum — unreachable.
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// Placement state → the Placement-OWNED journey stage (via STATE_POSITION, D-1: any established
// placement is at least ACCEPTED_PLACED; STARTED reads STARTED even when the legacy Pipeline
// row still shows offered/placed).
function placementOwnedStage(state: PlacementProcessView['state']): JourneyStageName {
  switch (state) {
    case 'STARTED':
      return 'STARTED';
    case 'READY_TO_START':
      return 'READY';
    case 'PRE_START':
    case 'BLOCKED':
      return 'PRE_START';
    default:
      // READY_TO_START / STARTED / terminal (NO_SHOW/FELL_THROUGH): the fill
      // (establishment) happened — the placement exists — so it is at least ACCEPTED_PLACED.
      return 'ACCEPTED_PLACED';
  }
}

@Injectable()
export class TalentJourneyReadService {
  constructor(
    private readonly pipeline: PipelineRepository,
    private readonly submittal: SubmittalRepository,
    private readonly clientSelection: ClientSelectionProcessRepository,
    private readonly interview: InterviewSessionRepository,
    private readonly journeyProjection: JourneyProjectionRepository,
    private readonly offer: OfferRepository,
    private readonly placement: PlacementRepository,
    private readonly preStart: RequirementInstanceRepository,
    @Inject('TalentJourneyLogger') private readonly logger: AramoLogger,
  ) {}

  // Compose the journey for ONE pipeline episode. `visible_requisition_ids` is the pre-resolved
  // AUTHZ-D4b set (null = see-all). A non-visible / cross-tenant episode is concealed as 404.
  async getJourney(args: {
    tenant_id: string;
    pipeline_id: string;
    visible_requisition_ids: ReadonlySet<string> | null;
    requestId: string;
  }): Promise<TalentRequisitionJourney> {
    // Gate 1 (AUTHZ existence) — the episode itself; null ⇒ absent OR not-visible ⇒ same 404.
    const episode = await this.pipeline.findByIdForActor({
      tenant_id: args.tenant_id,
      id: args.pipeline_id,
      visible_requisition_ids: args.visible_requisition_ids,
    });
    if (episode === null) {
      throw new AramoError('NOT_FOUND', 'Talent journey not found in tenant (or not visible to actor)', 404, {
        requestId: args.requestId,
      });
    }
    const requisition_id = episode.requisition_id;
    const talent_record_id = episode.talent_record_id;
    const vis = args.visible_requisition_ids;

    // Level 1 — the Submittal on this (talent, requisition) grain (visibility-scoped).
    const submittal = await this.submittal.findByTenantTalentJobForActor({
      tenant_id: args.tenant_id,
      talent_id: talent_record_id,
      job_id: requisition_id,
      visible_requisition_ids: vis,
    });

    // Level 2 — the three per-submittal owners, BATCHED (never a per-row loop).
    let selection: ClientSelectionProcessView | null = null;
    let currentOffer: OfferView | null = null;
    let currentPlacement: PlacementProcessView | null = null;
    if (submittal !== null) {
      const [sel, offers, placements] = await Promise.all([
        this.clientSelection.findBySubmittalId({ tenant_id: args.tenant_id, submittal_id: submittal.id }),
        this.offer.list({ tenant_id: args.tenant_id, submittal_id: submittal.id, visible_requisition_ids: vis }),
        this.placement.listForActor({ tenant_id: args.tenant_id, submittal_id: submittal.id, visible_requisition_ids: vis }),
      ]);
      selection = sel;
      currentOffer = pickCurrentOffer(offers);
      currentPlacement = placements[0] ?? null; // listForActor is created_at desc — [0] is current
    }

    // Level 3a — the client-selection-sourced stages (L2-F3 primitive, R1) + interview sub-state.
    let derivedSelectionStages: Awaited<ReturnType<JourneyProjectionRepository['deriveJourneyStages']>> = [];
    let interviewSession: InterviewSessionView | null = null;
    if (selection !== null) {
      const [stages, session] = await Promise.all([
        this.journeyProjection.deriveJourneyStages({ tenant_id: args.tenant_id, client_selection_process_id: selection.id }),
        this.interview.findLatestByProcess({ tenant_id: args.tenant_id, client_selection_process_id: selection.id }),
      ]);
      derivedSelectionStages = stages;
      interviewSession = session;
    }

    // Level 3b — the placement children (pre-start readiness + assignment), BATCHED.
    let preStartInstances: readonly PreStartInstanceView[] = [];
    let assignment: ContractAssignmentView | null = null;
    if (currentPlacement !== null) {
      const [instances, asg] = await Promise.all([
        this.preStart.findByPlacement(args.tenant_id, currentPlacement.id),
        this.placement.findAssignmentByPlacement(args.tenant_id, currentPlacement.id),
      ]);
      preStartInstances = instances;
      assignment = asg;
    }

    // ---- Compose owner-attributed stages (a stage is emitted ONLY with a backing owner row) --
    const stages: JourneyStageElement[] = [];

    const pStage = pipelineOwnedStage(episode.status);
    if (pStage !== null) {
      stages.push({ stage: pStage, owner: 'pipeline', source_object_id: episode.id, occurred_at: episode.updated_at ?? undefined });
    }
    if (submittal !== null && submittal.state === 'submitted_to_ats') {
      stages.push({ stage: 'SUBMITTED', owner: 'submittal', source_object_id: submittal.id });
    }
    if (selection !== null) {
      // The process existing means Client Review was reached (its initial state).
      stages.push({ stage: 'CLIENT_REVIEW', owner: 'client-selection', source_object_id: selection.id, occurred_at: selection.created_at });
    }
    // R1 — consume the L2-F3 owner-sourced primitive; normalize {source, client_selection_process_id}
    // → {owner:'client-selection', source_object_id}. Emits INTERVIEW / CLIENT_DECLINED.
    for (const s of derivedSelectionStages) {
      stages.push({
        stage: s.stage,
        owner: 'client-selection',
        source_object_id: s.client_selection_process_id,
        occurred_at: s.occurred_at,
      });
    }
    if (currentOffer !== null && OFFER_STATE_POSITION[currentOffer.state] !== 'CLOSED') {
      stages.push({ stage: 'OFFER', owner: 'offer', source_object_id: currentOffer.id });
    } else if (currentOffer !== null && stages.length === 0) {
      // A closed offer with no other signal still evidences the OFFER stage was reached.
      stages.push({ stage: 'OFFER', owner: 'offer', source_object_id: currentOffer.id });
    }
    if (currentPlacement !== null) {
      stages.push({ stage: placementOwnedStage(currentPlacement.state), owner: 'placement', source_object_id: currentPlacement.id });
    }

    // ---- sub_states — STATE ENUMS ONLY (R3), one per owner; null when the owner has no row. ---
    const sub_states: JourneySubStates = {
      pipeline_stage: episode.status,
      submittal_state: submittal?.state ?? null,
      selection_state: selection?.state ?? null,
      interview_state: interviewSession?.state ?? null,
      offer_state: currentOffer?.state ?? null,
      placement_state: currentPlacement?.state ?? null,
      pre_start_state: representativePreStartStatus(preStartInstances),
      assignment_state: assignment?.lifecycle_state ?? null,
    };

    // ---- current_journey_stage — the furthest-forward contribution (max ordinal). ----
    const current_journey_stage =
      stages.length === 0
        ? 'SOURCED'
        : stages.reduce((max, s) => (stageOrdinal(s.stage) > stageOrdinal(max) ? s.stage : max), stages[0]!.stage);

    // ---- actions — owner-specific, routing to each owner's EXISTING command (no journey write). --
    const actions = deriveActions({ episode, submittal, selection, currentOffer, currentPlacement, preStartInstances });

    this.logger.log({ event: 'talent_journey_composed', pipeline_id: episode.id, current_journey_stage, stage_count: stages.length });

    return {
      requisition_id,
      talent_record_id,
      current_journey_stage,
      stages,
      sub_states,
      actions,
    };
  }
}

// ≤1 NON-terminal offer per (tenant, submittal) — the one-live trigger; prefer it, else the
// most recent (list is created_at desc).
function pickCurrentOffer(offers: readonly OfferView[]): OfferView | null {
  if (offers.length === 0) return null;
  const open = offers.find((o) => OFFER_STATE_POSITION[o.state] !== 'CLOSED');
  return open ?? offers[0]!;
}

// The representative pre-start requirement status (imported RequirementStatusValue, Rule D):
// the FIRST unresolved (blocking) instance if any, else the first instance, else null. No
// re-declaration of the RESOLVED/UNRESOLVED partition — isUnresolvedStatus is imported.
function representativePreStartStatus(
  instances: readonly PreStartInstanceView[],
): JourneySubStates['pre_start_state'] {
  if (instances.length === 0) return null;
  const blocking = instances.find((i) => isUnresolvedStatus(i.status as never));
  return (blocking ?? instances[0]!).status;
}

// Owner-specific action affordances. Each names the owner's EXISTING command route; NEVER a
// generic status control (AC-5). Surfaced when the owner is at a state its command accepts.
function deriveActions(ctx: {
  episode: PipelineView;
  submittal: TalentSubmittalRecordView | null;
  selection: { readonly state: string } | null;
  currentOffer: OfferView | null;
  currentPlacement: PlacementProcessView | null;
  preStartInstances: readonly PreStartInstanceView[];
}): JourneyAction[] {
  const actions: JourneyAction[] = [];
  // Pipeline Qualify — available while the episode is in the qualifying funnel.
  if (ctx.episode.status === 'qualifying') {
    actions.push({ action: 'Qualify', owner: 'pipeline', command_route: `POST /v1/pipelines/${ctx.episode.id}/actions` });
  }
  // Submittal Submit to Client — available before the submittal is submitted_to_ats.
  if (ctx.submittal !== null && ctx.submittal.state !== 'submitted_to_ats') {
    actions.push({ action: 'Submit to Client', owner: 'submittal', command_route: `POST /v1/submittals/${ctx.submittal.id}/submit` });
  }
  // Offer creation — ONLY after ClientSelection is SELECTED (the delivered offer
  // precondition; OfferClientSelectionGate 409s otherwise). Emitting this action
  // before SELECTED advertised a premature "Create offer" for a just-added Talent
  // (workflow-sequencing defect). It is offered only when selection is SELECTED
  // AND there is no current open offer yet.
  if (
    ctx.selection?.state === 'SELECTED' &&
    (ctx.currentOffer === null || OFFER_STATE_POSITION[ctx.currentOffer.state] === 'CLOSED')
  ) {
    actions.push({ action: 'Create offer', owner: 'offer', command_route: `POST /v1/offers` });
  }
  // Pre-Start Complete Requirement — available while a blocking requirement is unresolved.
  if (ctx.currentPlacement !== null && ctx.preStartInstances.some((i) => isUnresolvedStatus(i.status as never))) {
    actions.push({ action: 'Complete Requirement', owner: 'pre-start', command_route: `POST /v1/placements/${ctx.currentPlacement.id}/requirements/:requirementId/transition` });
  }
  return actions;
}
