import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';
import {
  PipelineRepository,
  PIPELINE_STATUS_VALUES,
  type PipelineStatus,
} from '@aramo/pipeline';
import { SubmittalRepository } from '@aramo/submittal';
import {
  ClientSelectionProcessRepository,
  type ClientSelectionProcessView,
} from '@aramo/client-selection';
import {
  OfferRepository,
  PlacementRepository,
  OFFER_STATE_POSITION,
  type OfferView,
  type PlacementProcessView,
} from '@aramo/placement';
import {
  RequisitionSubmittalEligibilityReader,
  evaluateEligibility,
  type SubmittalPolicyInputs,
  type DocumentEligibilityInput,
  type EngagementEligibilityInput,
} from '@aramo/submittal-eligibility';
import { RequisitionAssignmentRepository, RequisitionRepository } from '@aramo/requisition';
import { ClientTalentRestrictionRepository } from '@aramo/client-talent-restriction';

import { DocumentReadinessGate } from '../rtr/document-readiness.gate.js';
import { EngagementGateService } from '../engagement/engagement-gate.service.js';

// TB-4 — the requisition-grain engagement applicability (resolved once; see
// EngagementGateService.resolveApplicability). Drives a TRUTHFUL band: 'policy_present' means
// the per-talent engagement verdict is not batch-evaluable here, so readiness is UNAVAILABLE
// (never a false-positive Ready) — never a neutralized default.
type EngagementApplicability = 'dormant' | 'policy_missing' | 'policy_present';

import type {
  BoardCardView,
  BoardClosedSummary,
  BoardColumnKey,
  BoardColumnView,
  BoardNextAction,
  BoardOwner,
  BoardReadiness,
  BoardResume,
  QualifiedBand,
  RequisitionTalentBoardView,
} from './dto/requisition-talent-board.view.js';

// Requisition Talent Board (TB-1) — the read-only Board projection composer. Mirrors
// `talent-journey-read.service.ts` (apps/api is the ONLY layer allowed to compose all
// scope:ats owners) but per-REQUISITION and BATCHED over the whole talent set:
//   Pipeline (listByRequisitionsAndStatus, ALL statuses)
//     → { Submittal-by-requisition, working-résumé-by-set, latest-history-by-set,
//         Offer-by-requisition, Placement-by-requisition, requisition readiness,
//         requisition assignment } read CONCURRENTLY (one query each; no per-card fan-out)
//        → ClientSelection-by-submittal-set (one IN-list read)
//           → per-talent DEEPEST-OWNER decision (below).
// STATE ENUMS ONLY (directive §1/§16) — NO compensation/bill field is composed here;
// financials ride their own scoped read boundary (TB-later). The Board is NEVER a source
// of truth: every column is attributed to an authoritative owner row (source_object_id);
// a column is never emitted without one.

// The Board's column order — its OWN display vocabulary (not an owner ontology), each mapped
// to an authoritative owner state in TB-0-projection-contract.md. Used to render every
// column (even empty) in a stable order.
const BOARD_COLUMN_ORDER: readonly BoardColumnKey[] = [
  'pipeline',
  'contacted',
  'qualified',
  'submitted',
  'interview',
  'selected',
  'offer',
  'accepted',
  'prestart',
  'ready',
  'started',
];

// TB-6 — the columns PAST the §3.2 handoff boundary (Offer onward). A card here is downstream:
// the Board tracks its lifecycle read-only, never owns it. `selected` is the LAST Board-owned
// column (the handoff point); everything after is handoff/tracking.
const HANDOFF_COLUMNS: ReadonlySet<BoardColumnKey> = new Set<BoardColumnKey>([
  'offer',
  'accepted',
  'prestart',
  'ready',
  'started',
]);

// One card's placement decision. The DEEPEST owner in the lineage that has a row is
// authoritative (mirrors `talent-journey-read` "downstream owns it"): it yields either an
// active column (attributed to that owner row) or a Closed disposition (negative terminal).
// `owner_state` is the persisted owner enum verbatim (Rule D — never re-derived).
type CardDecision =
  | { readonly kind: 'active'; readonly column: BoardColumnKey; readonly owner: BoardOwner; readonly source_object_id: string; readonly owner_state: string }
  | { readonly kind: 'closed'; readonly reason: string };

// Pipeline status → the Pipeline-OWNED forward column. The two terminals contribute NO
// forward column: `not_in_consideration` is a negative disposition (Closed), `completed`
// is the SUCCESSFUL system terminal whose forward position is carried by the downstream
// placement owner (never faked from the Pipeline value — SB-3 wall).
function pipelineColumn(status: PipelineStatus): BoardColumnKey | null {
  switch (status) {
    case 'no_contact':
      return 'pipeline';
    case 'contacted':
    case 'talent_responded':
      return 'contacted';
    case 'qualifying':
    case 'qualified':
      return 'qualified';
    case 'not_in_consideration':
    case 'completed':
      return null;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// ClientSelection state → forward column (CLIENT_REVIEW/INTERVIEW consideration; SELECTED
// is the §3.2 handoff boundary). DECLINED/WITHDRAWN are negative terminals (Closed).
function selectionColumn(state: ClientSelectionProcessView['state']): BoardColumnKey | null {
  switch (state) {
    case 'CLIENT_REVIEW':
    case 'INTERVIEW':
      return 'interview';
    case 'SELECTED':
      return 'selected';
    default:
      return null; // DECLINED / WITHDRAWN
  }
}

// Placement state → forward column (via the placement lifecycle states). NO_SHOW /
// FELL_THROUGH are negative terminals (Closed).
function placementColumn(state: PlacementProcessView['state']): BoardColumnKey | null {
  switch (state) {
    case 'PRE_START':
    case 'BLOCKED':
      return 'prestart';
    case 'READY_TO_START':
      return 'ready';
    case 'STARTED':
      return 'started';
    default:
      return null; // NO_SHOW / FELL_THROUGH
  }
}

// ≤1 non-terminal offer per (tenant, submittal) — prefer the open/accepted one, else the
// most recent (offer.list is created_at desc). Mirrors talent-journey `pickCurrentOffer`.
function pickCurrentOffer(offers: readonly OfferView[]): OfferView | null {
  if (offers.length === 0) return null;
  const live = offers.find((o) => OFFER_STATE_POSITION[o.state] !== 'CLOSED');
  return live ?? offers[0]!;
}

const MS_PER_DAY = 86_400_000;

@Injectable()
export class RequisitionTalentBoardReadService {
  constructor(
    private readonly pipeline: PipelineRepository,
    private readonly submittal: SubmittalRepository,
    private readonly clientSelection: ClientSelectionProcessRepository,
    private readonly offer: OfferRepository,
    private readonly placement: PlacementRepository,
    private readonly readiness: RequisitionSubmittalEligibilityReader,
    private readonly assignment: RequisitionAssignmentRepository,
    private readonly documentReadiness: DocumentReadinessGate,
    private readonly requisitions: RequisitionRepository,
    private readonly restriction: ClientTalentRestrictionRepository,
    private readonly engagement: EngagementGateService,
    @Inject('RequisitionTalentBoardLogger') private readonly logger: AramoLogger,
  ) {}

  // Compose the Board for ONE requisition. `visible_requisition_ids` is the pre-resolved
  // AUTHZ-D4b set (null = see-all). A requisition outside the visible set is concealed as
  // 404 (existence not disclosed) — never 403 — mirroring the pipeline/journey reads.
  // `now` is passed in (never read from a clock here) so days-in-stage + readiness are
  // deterministic (mirrors `deriveByRequisitionIds`).
  async getBoard(args: {
    tenant_id: string;
    requisition_id: string;
    visible_requisition_ids: ReadonlySet<string> | null;
    now: Date;
    requestId: string;
  }): Promise<RequisitionTalentBoardView> {
    const { tenant_id, requisition_id, requestId } = args;
    const vis = args.visible_requisition_ids;

    // Concealment gate: a non-visible requisition is a 404 (same as absent).
    if (vis !== null && !vis.has(requisition_id)) {
      throw new AramoError(
        'NOT_FOUND',
        'Requisition not found in tenant (or not visible to actor)',
        404,
        { requestId },
      );
    }

    // Stage 0 — the Pipeline spine (the join key the Board fans out from) + the requisition's
    // company_id (needed for the TB-4 client-restriction + engagement resolution), read in
    // parallel (both need only requisition_id).
    const [pipelineRows, company_id] = await Promise.all([
      this.pipeline.listByRequisitionsAndStatus({
        tenant_id,
        requisition_ids: [requisition_id],
        statuses: PIPELINE_STATUS_VALUES,
        limit: 1000,
      }),
      this.requisitions.findCompanyId({ tenant_id, id: requisition_id }),
    ]);

    const pipelineIds = pipelineRows.map((r) => r.id);
    const talentIds = pipelineRows.map((r) => r.talent_record_id);

    // Stage 1 — the owner reads, BATCHED + CONCURRENT (never per-card). Offer + Placement are
    // requisition-scoped in one call each; résumé + history are SET reads; the TB-4 readiness
    // substrate (raw policy inputs + the batched RTR gate) is read here too.
    const [submittals, resumeByTalent, historyByPipeline, offers, placements, readinessMap, assignments, policyInputsMap, rtrByTalent, restrictedTalentIds, engagementApplicability] =
      await Promise.all([
        this.submittal.listByRequisitionForBoard({
          tenant_id,
          requisition_id,
          visible_requisition_ids: vis,
        }),
        this.pipeline.listCurrentRequisitionResumes({
          tenant_id,
          requisition_id,
          talent_record_ids: talentIds,
        }),
        this.pipeline.listLatestStatusEntryForPipelines({ tenant_id, pipeline_ids: pipelineIds }),
        this.offer.list({ tenant_id, requisition_id, visible_requisition_ids: vis, limit: 200 }),
        this.placement.listForActor({ tenant_id, requisition_id, visible_requisition_ids: vis, limit: 200 }),
        this.readiness.deriveByRequisitionIds(tenant_id, [requisition_id], args.now),
        this.assignment.listForRequisition({ tenant_id, requisition_id }),
        // TB-4 — raw policy inputs (for the pure eligibility port) + the batched RTR gate.
        this.readiness.loadPolicyInputsByRequisitionIds(tenant_id, [requisition_id]),
        this.documentReadiness.assessMany({ tenant_id, requisition_id, talent_ids: talentIds }),
        // TB-4 — authoritative client-restriction (batched) + requisition-grain engagement
        // applicability (resolved once). Both feed the REAL eligibility port per card; neither
        // is neutralized to fabricate a positive Ready.
        company_id === null
          ? Promise.resolve(new Set<string>())
          : this.restriction.findActiveRestrictedTalentIds({ tenant_id, client_company_id: company_id, talent_record_ids: talentIds, now: args.now }),
        this.engagement.resolveApplicability({ tenant_id, company_id, requisition_id }),
      ]);

    // Stage 2 — ClientSelection for the whole submittal set, ONE IN-list read.
    const submittalIds = submittals.map((s) => s.id);
    const selections = await this.clientSelection.listBySubmittalIds({
      tenant_id,
      submittal_ids: submittalIds,
    });

    // ---- Index the batched results (in-memory joins; no further queries) ----------------
    const submittalByPipelineId = new Map<string, (typeof submittals)[number]>();
    for (const s of submittals) {
      if (s.pipeline_id !== null) submittalByPipelineId.set(s.pipeline_id, s);
    }
    const selectionBySubmittalId = new Map<string, ClientSelectionProcessView>();
    for (const sel of selections) selectionBySubmittalId.set(sel.submittal_id, sel);
    const offersBySubmittalId = new Map<string, OfferView[]>();
    for (const o of offers) {
      const list = offersBySubmittalId.get(o.submittal_id);
      if (list === undefined) offersBySubmittalId.set(o.submittal_id, [o]);
      else list.push(o);
    }
    const placementBySubmittalId = new Map<string, PlacementProcessView>();
    for (const p of placements) {
      // listForActor is created_at desc → the FIRST per submittal is the current one.
      if (!placementBySubmittalId.has(p.submittal_id)) placementBySubmittalId.set(p.submittal_id, p);
    }

    const req_readiness = readinessMap.get(requisition_id) ?? { status: 'open' as const, reason: null };
    // TB-4 — the requisition's raw policy inputs (for the pure eligibility port). R-DEFAULT-OPEN
    // when no policy row exists (the reader supplies the default inputs).
    const policy = policyInputsMap.get(requisition_id) ?? {
      inputs: { submittal_deadline: null, submittal_limit: null, manual_override: null, submittal_authority: 'ARAMO' as const },
      consumed_count: 0,
    };
    // G-B — the requisition-grain assigned recruiter (listForRequisition is assigned_at desc).
    const assigned_recruiter_user_id = assignments[0]?.user_id ?? null;

    // ---- Per-talent projection ----------------------------------------------------------
    const activeCards: BoardCardView[] = [];
    const closedReasons = new Map<string, number>();
    let closedTotal = 0;

    for (const row of pipelineRows) {
      const submittal = submittalByPipelineId.get(row.id) ?? null;
      const selection = submittal !== null ? selectionBySubmittalId.get(submittal.id) ?? null : null;
      const currentOffer =
        submittal !== null ? pickCurrentOffer(offersBySubmittalId.get(submittal.id) ?? []) : null;
      const currentPlacement =
        submittal !== null ? placementBySubmittalId.get(submittal.id) ?? null : null;

      // DEEPEST-owner decision — the furthest owner in the lineage that has a row is
      // authoritative for this card (active column OR Closed disposition).
      const decision = decideCard(row, submittal, selection, currentOffer, currentPlacement);

      if (decision.kind === 'closed') {
        closedReasons.set(decision.reason, (closedReasons.get(decision.reason) ?? 0) + 1);
        closedTotal += 1;
        continue;
      }

      activeCards.push(
        this.buildCard(row, decision, {
          submittal,
          resumeRow: resumeByTalent.get(row.talent_record_id) ?? null,
          history: historyByPipeline.get(row.id) ?? null,
          req_readiness,
          policy,
          rtr_verdict: rtrByTalent.get(row.talent_record_id) ?? null,
          restriction_active: restrictedTalentIds.has(row.talent_record_id),
          engagement: engagementApplicability,
          assigned_recruiter_user_id,
          now: args.now,
        }),
      );
    }

    // ---- Assemble columns (every board column present, even when empty) -----------------
    const columns: BoardColumnView[] = BOARD_COLUMN_ORDER.map((key) => {
      const cards = activeCards.filter((c) => c.column === key);
      return {
        key,
        owner: cards[0]?.owner ?? boardColumnDefaultOwner(key),
        count: cards.length,
        cards,
      };
    });

    const closed: BoardClosedSummary = {
      total: closedTotal,
      by_reason: Array.from(closedReasons.entries())
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    };

    this.logger.log({
      event: 'requisition_talent_board_composed',
      requisition_id,
      active: activeCards.length,
      closed: closedTotal,
      pipeline_rows: pipelineRows.length,
    });

    return {
      requisition_id,
      columns,
      closed,
      total_active: activeCards.length,
    };
  }

  // Build a single card from its (active) decision + the batched side-lookups. NO query
  // is issued here (all inputs are pre-batched). STATE ENUMS ONLY.
  private buildCard(
    row: { id: string; talent_record_id: string; status: PipelineStatus },
    winner: Extract<CardDecision, { kind: 'active' }>,
    ctx: {
      submittal: { id: string; resume_edition_id: string | null; state: string } | null;
      resumeRow: { resume_edition_id: string } | null;
      history: { changed_at: Date } | null;
      req_readiness: { status: 'open' | 'paused' | 'closed'; reason: string | null };
      policy: { inputs: SubmittalPolicyInputs; consumed_count: number };
      rtr_verdict: DocumentEligibilityInput | null;
      restriction_active: boolean;
      engagement: EngagementApplicability;
      assigned_recruiter_user_id: string | null;
      now: Date;
    },
  ): BoardCardView {
    const resume = deriveResume(ctx.submittal, ctx.resumeRow);
    const { days_in_stage, stage_entered_at } = deriveDwell(ctx.history, ctx.now);
    // rtr_state — the DOC-5 per-talent fact (from the batched RTR gate). Only the ACTIONABLE
    // NOT_EXECUTED state is surfaced; a satisfied verdict (executed OR RTR-not-required) carries
    // no RTR concern, so it stays null rather than fabricating an EXECUTED value the verdict
    // shape cannot distinguish from ungated.
    const rtr_state = ctx.rtr_verdict !== null && !ctx.rtr_verdict.satisfied ? 'NOT_EXECUTED' : null;
    // Readiness band (§6) — meaningful only for the Qualified column. TB-4 (remediated): grounded
    // on the REAL `evaluateEligibility` port over ALL applicable submit gates — window (raw policy
    // inputs), client restriction (authoritative batched), engagement (requisition-grain
    // applicability), and RTR. READY TO SUBMIT is asserted ONLY when every applicable gate is
    // satisfied; when engagement is applicable but not batch-evaluable ('policy_present'),
    // readiness is UNAVAILABLE → NEEDS ACTION, NEVER a false-positive Ready.
    const readiness: BoardReadiness | null =
      winner.column === 'qualified'
        ? deriveQualifiedReadiness({
            req_readiness: ctx.req_readiness,
            resume,
            policy: ctx.policy,
            rtr_verdict: ctx.rtr_verdict,
            restriction_active: ctx.restriction_active,
            engagement: ctx.engagement,
            now: ctx.now,
          })
        : null;

    return {
      talent_record_id: row.talent_record_id,
      pipeline_id: row.id,
      column: winner.column,
      owner: winner.owner,
      source_object_id: winner.source_object_id,
      owner_state: winner.owner_state,
      resume,
      rtr_state,
      readiness,
      days_in_stage,
      stage_entered_at,
      assigned_recruiter_user_id: ctx.assigned_recruiter_user_id,
      next_actions: deriveNextActions(winner, row.id),
      handoff: HANDOFF_COLUMNS.has(winner.column),
    };
  }
}

// The BOUNDED next-action projection (TB-3) — the ONE (or zero) governed command the card's
// DEEPEST owner exposes for its current state. Owner-attributed, routed to an EXISTING
// governed command, gated by the owner state — mirrors `talent-journey-read.deriveActions`.
// This is NOT a generic action-availability engine: there is no capability matrix and no
// `GET /available-actions`; each arm below is a hand-authored owner transition. The offer
// create is gated on ClientSelection SELECTED (the S3-FIX sequencing guard — never advertise
// "Create offer" before the client has selected). Downstream owners whose next command needs
// a child id (pre-start requirement) or is system-driven (placement establishment) emit no
// Board action — those run in the governed drawer surface (TB-5 rides this same path).
function deriveNextActions(
  winner: Extract<CardDecision, { kind: 'active' }>,
  pipelineId: string,
): BoardNextAction[] {
  const PIPELINE_ROUTE = `POST /v1/pipelines/${pipelineId}/actions`;
  switch (winner.owner) {
    case 'pipeline':
      switch (winner.owner_state) {
        case 'no_contact':
          return [{ key: 'pipeline.contact', label: 'Mark contacted', owner: 'pipeline', command_route: PIPELINE_ROUTE, required_scope: 'pipeline:change-status' }];
        case 'contacted':
          return [{ key: 'pipeline.mark_responded', label: 'Mark responded', owner: 'pipeline', command_route: PIPELINE_ROUTE, required_scope: 'pipeline:change-status' }];
        case 'talent_responded':
          return [{ key: 'pipeline.start_qualification', label: 'Start qualification', owner: 'pipeline', command_route: PIPELINE_ROUTE, required_scope: 'pipeline:change-status' }];
        case 'qualifying':
          return [{ key: 'pipeline.qualify', label: 'Qualify', owner: 'pipeline', command_route: PIPELINE_ROUTE, required_scope: 'pipeline:change-status' }];
        default:
          // `qualified` (top of the recruiter ladder — submit runs in the drawer wizard) and
          // the `started`/`completed` fallback have no bounded pipeline command here.
          return [];
      }
    case 'client_selection': {
      const CS_ROUTE = `POST /v1/client-selection/${winner.source_object_id}/transition`;
      switch (winner.owner_state) {
        case 'CLIENT_REVIEW':
          return [{ key: 'client_selection.advance_interview', label: 'Advance to interview', owner: 'client_selection', command_route: CS_ROUTE, required_scope: 'client-selection:transition' }];
        case 'INTERVIEW':
          return [{ key: 'client_selection.mark_selected', label: 'Mark client selected', owner: 'client_selection', command_route: CS_ROUTE, required_scope: 'client-selection:transition' }];
        case 'SELECTED':
          // Offer creation is the SELECTED-gated §3.2 handoff — the ONLY forward step here.
          return [{ key: 'offer.create', label: 'Create offer', owner: 'offer', command_route: 'POST /v1/offers', required_scope: 'offer:create' }];
        default:
          return [];
      }
    }
    case 'offer':
      // An OPEN offer (DRAFT/SENT/NEGOTIATION) advances via the generic governed transition;
      // ACCEPTED is terminal-positive for the offer (placement is downstream/system).
      return winner.column === 'offer'
        ? [{ key: 'offer.transition', label: 'Update offer', owner: 'offer', command_route: `PATCH /v1/offers/${winner.source_object_id}`, required_scope: 'offer:transition' }]
        : [];
    case 'submittal':
    case 'placement':
      // Submittal (post-submit, client owns next) and Placement (pre-start requirement / system
      // establishment) expose no single bounded Board command — handled in the drawer surface.
      return [];
    default: {
      const _exhaustive: never = winner.owner;
      return _exhaustive;
    }
  }
}

// The DEEPEST-owner card decision (mirrors talent-journey "downstream owns it"). Walk the
// lineage from the furthest owner inward; the first owner that HAS a row is authoritative —
// it yields either an active column (attributed to that owner row) or a Closed disposition
// (its negative terminal). Reasons are canonical owner enums verbatim (never a Board
// taxonomy — §18), namespaced by owner so materially-different causes stay distinct.
function decideCard(
  row: { id: string; status: PipelineStatus },
  submittal: { id: string; state: string } | null,
  selection: ClientSelectionProcessView | null,
  offer: OfferView | null,
  placement: PlacementProcessView | null,
): CardDecision {
  // 1) Placement — the deepest owner. STARTED/READY/PRE_START active; NO_SHOW/FELL_THROUGH closed.
  if (placement !== null) {
    const col = placementColumn(placement.state);
    return col !== null
      ? { kind: 'active', column: col, owner: 'placement', source_object_id: placement.id, owner_state: placement.state }
      : { kind: 'closed', reason: `placement_${placement.state.toLowerCase()}` };
  }
  // 2) Offer — OPEN→offer, ACCEPTED→accepted; DECLINED/EXPIRED/RESCINDED closed.
  if (offer !== null) {
    const pos = OFFER_STATE_POSITION[offer.state];
    if (pos === 'OPEN') return { kind: 'active', column: 'offer', owner: 'offer', source_object_id: offer.id, owner_state: offer.state };
    if (pos === 'ACCEPTED') return { kind: 'active', column: 'accepted', owner: 'offer', source_object_id: offer.id, owner_state: offer.state };
    return { kind: 'closed', reason: `offer_${offer.state.toLowerCase()}` };
  }
  // 3) ClientSelection — review/interview/selected active; DECLINED/WITHDRAWN closed.
  if (selection !== null) {
    const col = selectionColumn(selection.state);
    return col !== null
      ? { kind: 'active', column: col, owner: 'client_selection', source_object_id: selection.id, owner_state: selection.state }
      : { kind: 'closed', reason: `client_${selection.state.toLowerCase()}` };
  }
  // 4) Submittal — only a SUBMITTED (or client-confirmed) submittal advances past the pipeline
  //    columns; a pre-submit submittal (created/handoff_draft/ready_for_review/revoked) does not,
  //    so it falls through to the Pipeline spine below.
  if (submittal !== null && (submittal.state === 'submitted_to_ats' || submittal.state === 'confirmed')) {
    return { kind: 'active', column: 'submitted', owner: 'submittal', source_object_id: submittal.id, owner_state: submittal.state };
  }
  // 5) Pipeline spine — the active funnel columns; `not_in_consideration` is the canonical
  //    Closed disposition; `completed` (successful terminal, no downstream row) surfaces in
  //    `started` so it is never silently dropped.
  const pCol = pipelineColumn(row.status);
  if (pCol !== null) {
    return { kind: 'active', column: pCol, owner: 'pipeline', source_object_id: row.id, owner_state: row.status };
  }
  if (row.status === 'not_in_consideration') return { kind: 'closed', reason: 'not_in_consideration' };
  // `completed` with no downstream placement row.
  return { kind: 'active', column: 'started', owner: 'pipeline', source_object_id: row.id, owner_state: row.status };
}

// Résumé linkage (§13) — the frozen submitted edition once submitted, else the working
// selection, else none. NEVER the Talent's latest résumé (no substitution).
function deriveResume(
  submittal: { resume_edition_id: string | null; state: string } | null,
  resumeRow: { resume_edition_id: string } | null,
): BoardResume {
  if (submittal !== null && submittal.resume_edition_id !== null) {
    return { resume_edition_id: submittal.resume_edition_id, source: 'submitted_frozen', locked: true };
  }
  if (resumeRow !== null) {
    return { resume_edition_id: resumeRow.resume_edition_id, source: 'working_selection', locked: false };
  }
  return { resume_edition_id: null, source: 'none', locked: false };
}

// Days-in-stage (§22 / G-A) — derived from the latest PipelineStatusHistory transition
// timestamp (when the current status was entered), NOT fabricated from `updated_at`.
function deriveDwell(
  history: { changed_at: Date } | null,
  now: Date,
): { days_in_stage: number | null; stage_entered_at: string | null } {
  if (history === null) return { days_in_stage: null, stage_entered_at: null };
  const ms = now.getTime() - history.changed_at.getTime();
  return {
    days_in_stage: ms < 0 ? 0 : Math.floor(ms / MS_PER_DAY),
    stage_entered_at: history.changed_at.toISOString(),
  };
}

// The engagement verdict passed to the pure port for a given requisition-grain applicability.
// - dormant        → satisfied (authoritative: the real gate returns satisfied when not governed).
// - policy_missing  → the fail-closed deny (authoritative: governed tenant, no effective policy).
// - policy_present  → NOT passed to the port here; the band instead records a distinct
//                     'engagement_readiness_unavailable' blocker so it NEVER asserts Ready
//                     (the per-talent evidence read is not batched — never neutralized).
function engagementVerdict(applicability: EngagementApplicability): EngagementEligibilityInput | undefined {
  switch (applicability) {
    case 'dormant':
      return { satisfied: true, deny: null };
    case 'policy_missing':
      return { satisfied: false, deny: 'CLIENT_SUBMITTAL_ENGAGEMENT_POLICY_MISSING', missing: [] };
    case 'policy_present':
      return undefined; // handled as an explicit UNAVAILABLE blocker below
  }
}

// The Qualified band (§6) — TB-4 (remediated). Grounded on the REAL `evaluateEligibility` port
// over EVERY applicable submit gate — window (raw policy inputs), client restriction
// (authoritative, batched), engagement (requisition-grain applicability), RTR (DOC-5) — plus the
// orthogonal Board résumé pre-check. NO duplicated policy logic (TE-9: the port is the one
// authority). The invariant: READY TO SUBMIT ⟺ every applicable gate satisfied; if engagement is
// applicable but not batch-evaluable, readiness is UNAVAILABLE → NEEDS ACTION, never a
// false-positive Ready. The submit transaction re-evaluates all of this authoritatively at
// mutation time; the band is a truthful preflight, not the authority.
export function deriveQualifiedReadiness(args: {
  req_readiness: { status: 'open' | 'paused' | 'closed'; reason: string | null };
  resume: BoardResume;
  policy: { inputs: SubmittalPolicyInputs; consumed_count: number };
  rtr_verdict: DocumentEligibilityInput | null;
  restriction_active: boolean;
  engagement: EngagementApplicability;
  now: Date;
}): BoardReadiness {
  const engagement = engagementVerdict(args.engagement);
  const decision = evaluateEligibility(args.policy.inputs, {
    now: args.now,
    consumed_count: args.policy.consumed_count,
    restriction_active: args.restriction_active, // authoritative (batched), not neutralized
    ...(engagement !== undefined ? { engagement } : {}),
    ...(args.rtr_verdict !== null ? { document: args.rtr_verdict } : {}),
  });
  const blockers: string[] = [];
  if (!decision.eligible && decision.deny !== undefined) blockers.push(denyToBlocker(decision.deny));
  // Engagement applicable but not batch-evaluable → readiness UNAVAILABLE (never Ready).
  if (args.engagement === 'policy_present') blockers.push('engagement_readiness_unavailable');
  // Orthogonal Board pre-check: a submit needs a selected résumé (not part of the policy port).
  if (args.resume.source === 'none') blockers.push('resume_not_selected');
  const band: QualifiedBand = blockers.length === 0 ? 'ready_to_submit' : 'needs_action';
  return {
    requisition_state: args.req_readiness.status,
    requisition_reason: args.req_readiness.reason,
    blockers,
    band,
  };
}

// Map the port's typed deny code → the Board's blocker vocabulary (canonical, UI-labelled).
function denyToBlocker(deny: string): string {
  switch (deny) {
    case 'SUBMITTAL_WINDOW_PASSED':
      return 'submittal_window_passed';
    case 'SUBMITTAL_LIMIT_REACHED':
      return 'submittal_limit_reached';
    case 'SUBMITTALS_CLOSED':
      return 'submittals_closed';
    case 'TALENT_RESTRICTED_AT_CLIENT':
      return 'client_restricted';
    case 'CLIENT_SUBMITTAL_ENGAGEMENT_POLICY_MISSING':
      return 'engagement_policy_missing';
    case 'CLIENT_SUBMITTAL_ENGAGEMENT_INCOMPLETE':
    case 'CLIENT_SUBMITTAL_ENGAGEMENT_EVIDENCE_UNAVAILABLE':
      return 'engagement_readiness_unavailable';
    case 'SUBMITTAL_RTR_NOT_EXECUTED':
      return 'rtr_not_executed';
    default:
      return deny.toLowerCase();
  }
}

// The natural owner of an empty column (attribution when no card is present).
function boardColumnDefaultOwner(key: BoardColumnKey): BoardOwner {
  switch (key) {
    case 'pipeline':
    case 'contacted':
    case 'qualified':
      return 'pipeline';
    case 'submitted':
      return 'submittal';
    case 'interview':
    case 'selected':
      return 'client_selection';
    case 'offer':
    case 'accepted':
      return 'offer';
    case 'prestart':
    case 'ready':
    case 'started':
      return 'placement';
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}
