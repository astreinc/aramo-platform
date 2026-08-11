import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError, isIso4217Currency, isRatePeriod } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';
import {
  canTransition,
  DUPLICATE_GUARD_INACTIVE,
  INITIAL_STATE,
  isPlacementGuardReleased,
  type PlacementState,
} from './lifecycle/placement-lifecycle.js';
import {
  classifyTransitionReason,
  type ReasonClassification,
  type ReasonEvidence,
} from './reasons/placement-reason-registry.js';
import type {
  CommercialTermsInput,
  ContractAssignmentEndReason,
  ContractAssignmentView,
  CreatePlacementInput,
  PlacementProcessView,
  TransitionPlacementInput,
} from './placement-process.types.js';

// Row shape as returned by Prisma (subset used by the projection). Cast at the
// read boundary — keeps the repository decoupled from the generated client path.
interface PlacementProcessRow {
  id: string;
  tenant_id: string;
  submittal_id: string;
  requisition_id: string;
  talent_record_id: string;
  state: PlacementState;
  offered_at: Date;
  proposed_start_date: Date | null;
  offer_expires_at: Date | null;
  client_offer_reference: string | null;
  offer_terms_summary: string | null;
  created_at: Date;
}

function projectView(row: PlacementProcessRow): PlacementProcessView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    submittal_id: row.submittal_id,
    requisition_id: row.requisition_id,
    talent_record_id: row.talent_record_id,
    state: row.state,
    offered_at: row.offered_at,
    proposed_start_date: row.proposed_start_date,
    offer_expires_at: row.offer_expires_at,
    client_offer_reference: row.client_offer_reference,
    offer_terms_summary: row.offer_terms_summary,
    created_at: row.created_at,
  };
}

// The placement OutboxEvent types (9-c-2). Generic lifecycle events, NOT one per
// outcome. Aggregate identity lives in the payload (house pattern).
const OUTBOX_CREATED = 'placement.process.created';
const OUTBOX_STATE_CHANGED = 'placement.process.state_changed';
// Track 4 / T4-D — the ContractAssignment ending domain event.
const OUTBOX_ASSIGNMENT_ENDED = 'placement.assignment.ended';
// Track 5 / T5-P1 — the initial Assignment Rate Version creation domain event.
// Identity/provenance ONLY (Amendment A2 §8): NEVER pay/bill/spread/margin/markup/
// currency/rate_period. It announces that commercial state exists; the figures are
// served by the protected read surface (T5-P2), never the append-only, non-reset-
// covered outbox.
const OUTBOX_RATE_VERSION_CREATED = 'placement.assignment.rate_version.created';

// Track 5 / T5-P1 — a decimal money string (never a float): up to 10 integer
// digits and up to 2 fractional, matching the Decimal(12,2) column. Defensive
// repository guard (the HTTP DTO also validates) — the repo is called directly by
// integration proofs, so the write boundary must not trust the amount format.
const MONEY_12_2 = /^\d{1,10}(\.\d{1,2})?$/;

// The BEFORE INSERT / BEFORE UPDATE lifecycle trigger raises a named
// check_violation. Detection is by the RAISE message substring (E7 precedent):
// SQLSTATE 23514 is shared across the two branches, so only the message text
// distinguishes a duplicate-live violation from a transition violation.
function errMessage(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const e = err as { message?: unknown };
  return typeof e.message === 'string' ? e.message : '';
}

function isDuplicateLiveViolation(err: unknown): boolean {
  return errMessage(err).includes('at most one live attempt');
}

function isTransitionViolation(err: unknown): boolean {
  return errMessage(err).includes('only the 14 legal state transitions');
}

// PlacementRepository — create + governed transition + event persistence for
// the PlacementProcess spine (Track 3 / E1-a §9).
//
// The DB trigger is the authority (the one-live-attempt guard and the 14-edge
// matrix are enforced there, generated from the registry). The repository adds
// the dominant submittal/engagement pattern: a pre-emptive application-layer
// guard that returns a structured domain error BEFORE the SQL, with the trigger
// as the race-safe floor caught by message substring. Raw Postgres exceptions
// are never surfaced to the caller (§ error handling).
@Injectable()
export class PlacementRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Create a new PlacementProcess. An offer was made, so the initial state is
  // OFFER_EXTENDED (§4). Rejects a second LIVE attempt for the same
  // (tenant_id, submittal_id) — PLACEMENT_ALREADY_LIVE (409).
  async createPlacement(input: CreatePlacementInput, requestId: string): Promise<PlacementProcessView> {
    // E4 — replacement lineage validation (§5). When replaces_placement_process_id
    // is present, this attempt is a replacement. Authorization (placement:create
    // AND placement:replace) was already enforced upstream at the controller (§3);
    // here we validate the linkage. The predecessor must exist in THIS tenant, be
    // in a pre-start TERMINAL state (DUPLICATE_GUARD_INACTIVE — the SAME derived
    // set the one-live guard releases on; §A4, no second list), and share the
    // requisition. There is no FK (§4.2): this create-time check is the SOLE
    // referential-integrity mechanism. Cross-tenant and cross-requisition both
    // fold to predecessor_not_found (least-visibility; the two-discriminator set
    // is {predecessor_not_found, predecessor_not_terminal} — §5).
    const replacesId = input.replaces_placement_process_id ?? null;
    if (replacesId !== null) {
      const predecessor = (await this.prisma.placementProcess.findFirst({
        where: { tenant_id: input.tenant_id, id: replacesId },
      })) as PlacementProcessRow | null;
      if (predecessor === null || predecessor.requisition_id !== input.requisition_id) {
        throw this.replacementInvalid('predecessor_not_found', input, replacesId, requestId);
      }
      if (!(DUPLICATE_GUARD_INACTIVE as readonly PlacementState[]).includes(predecessor.state)) {
        throw this.replacementInvalid('predecessor_not_terminal', input, replacesId, requestId);
      }
    }

    // Pre-emptive guard (Track 4 / T4-C, G2 §3.2) — ASSIGNMENT-AWARE. An attempt
    // is any non-terminal placement for (tenant, submittal); it is still LIVE
    // unless it is STARTED with an ENDED ContractAssignment (the SEPARATE
    // guard-release predicate, distinct from E4's DUPLICATE_GUARD_INACTIVE). The
    // DB trigger (20260810110000) is the authority; this returns the structured
    // PLACEMENT_ALREADY_LIVE before the INSERT.
    const attempts = (await this.prisma.placementProcess.findMany({
      where: {
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        state: { notIn: [...DUPLICATE_GUARD_INACTIVE] },
      },
      select: { id: true, state: true },
    })) as Array<{ id: string; state: PlacementState }>;
    for (const a of attempts) {
      const hasEndedAssignment =
        a.state === 'STARTED' &&
        (await this.prisma.contractAssignment.count({
          where: { tenant_id: input.tenant_id, placement_process_id: a.id, lifecycle_state: 'ENDED' },
        })) > 0;
      // An attempt is live unless its guard is released (STARTED + ended assignment).
      if (!isPlacementGuardReleased(a.state, hasEndedAssignment)) {
        throw this.alreadyLive(input, requestId, a.id);
      }
    }

    // Offer snapshot (9-c-1). offered_at defaults to the server time of the offer
    // fact. offer_expires_at, when present, must not precede offered_at.
    const offered_at = input.offered_at ?? new Date();
    if (input.offer_expires_at != null && input.offer_expires_at.getTime() < offered_at.getTime()) {
      throw new AramoError('VALIDATION_ERROR', 'offer_expires_at must not precede offered_at', 400, {
        requestId,
        details: { field: 'offer_expires_at', offered_at, offer_expires_at: input.offer_expires_at },
      });
    }

    try {
      // Transactional outbox (9-c-2): the PlacementProcess row and its
      // placement.process.created event commit atomically or not at all.
      const row = await this.prisma.$transaction(async (tx) => {
        const created = (await tx.placementProcess.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            submittal_id: input.submittal_id,
            requisition_id: input.requisition_id,
            talent_record_id: input.talent_record_id,
            state: INITIAL_STATE,
            offered_at,
            proposed_start_date: input.proposed_start_date ?? null,
            offer_expires_at: input.offer_expires_at ?? null,
            client_offer_reference: input.client_offer_reference ?? null,
            offer_terms_summary: input.offer_terms_summary ?? null,
            // E4 — replacement lineage, written once at INSERT (§4/§5).
            replaces_placement_process_id: replacesId,
          },
        })) as PlacementProcessRow;
        await tx.outboxEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            event_type: OUTBOX_CREATED,
            // Non-sensitive operational offer snapshot — NO commercial rates,
            // restricted evidence, or authorization detail (9-c-2). offer_terms_summary
            // is DELIBERATELY EXCLUDED (PR-A correction): it is recruiter-authored free
            // text tied to a named individual, and placement.OutboxEvent is append-only
            // + not tenant-reset-covered, so copying it here would make it permanent.
            // It stays on the PlacementProcess row; it must never enter this payload.
            event_payload: {
              placement_process_id: created.id,
              tenant_id: created.tenant_id,
              submittal_id: created.submittal_id,
              requisition_id: created.requisition_id,
              talent_record_id: created.talent_record_id,
              state: created.state,
              offered_at: created.offered_at.toISOString(),
              proposed_start_date: created.proposed_start_date?.toISOString() ?? null,
              offer_expires_at: created.offer_expires_at?.toISOString() ?? null,
              client_offer_reference: created.client_offer_reference,
              occurred_at: created.created_at.toISOString(),
            },
          },
        });
        return created;
      });
      return projectView(row);
    } catch (err) {
      // Race-safe floor: the BEFORE INSERT trigger rejected a concurrent
      // second live attempt (rolls back the outbox row too).
      if (isDuplicateLiveViolation(err)) {
        throw this.alreadyLive(input, requestId, undefined);
      }
      throw err;
    }
  }

  // Governed state transition. Pre-emptively rejects an illegal edge
  // (PLACEMENT_STATE_INVALID, 422) before the UPDATE, then transitions and
  // appends a state_transition event atomically. The traversal is recorded in
  // PlacementProcessEvent even when the move is immediate and unconditional
  // (§4d — PRE_START → READY_TO_START with no requirements).
  async transition(input: TransitionPlacementInput, requestId: string): Promise<PlacementProcessView> {
    const current = (await this.prisma.placementProcess.findFirst({
      where: { tenant_id: input.tenant_id, id: input.placement_process_id },
    })) as PlacementProcessRow | null;
    if (current === null) {
      throw new AramoError('NOT_FOUND', 'PlacementProcess not found', 404, {
        requestId,
        details: { placement_process_id: input.placement_process_id, reason: 'placement_process_not_found' },
      });
    }

    if (!canTransition(current.state, input.to)) {
      throw this.stateInvalid(current.state, input.to, requestId, input.placement_process_id);
    }

    // E3 — validate the reason evidence BEFORE any mutation. A governed terminal
    // target requires a valid canonical reason code; a non-governed edge must
    // carry none. Authorization (placement:terminate) is enforced upstream at the
    // controller, so a caller lacking terminate is already refused before here.
    const classification = classifyTransitionReason({
      to: input.to,
      reason_code: input.reason_code,
      reason_detail: input.reason_detail,
    });
    if (!classification.ok) {
      throw this.reasonInvalid(classification, current.state, input, requestId);
    }
    const evidence: ReasonEvidence | null = classification.evidence;

    // Track 4 / T4-A1 — a transition to STARTED materialises the authoritative
    // ContractAssignment, whose FORWARD provenance requires a company snapshot
    // (the DB CHECK). Validate the caller supplied it BEFORE the tx, so a missing
    // context is a clean 422, never a raw check_violation rollback (§4: the org
    // snapshot is caller-supplied — placement performs no cross-schema read).
    if (input.to === 'STARTED' && !input.assignment_context?.company_id) {
      throw new AramoError(
        'PLACEMENT_START_CONTEXT_REQUIRED',
        'Starting a placement requires assignment org context (company_id)',
        422,
        {
          requestId,
          details: { placement_process_id: input.placement_process_id, reason: 'assignment_context_required' },
        },
      );
    }

    // Track 5 / T5-P1 — commercial-terms policy, validated BEFORE the transaction
    // so a missing/invalid payload is a clean 422/400 with ZERO mutation
    // (Amendment A1-3). Commercial terms belong ONLY to the FORWARD assignment-start
    // seam: REQUIRED for STARTED, REJECTED for every other target (never silently
    // discarded). currency/rate_period are checked against the libs/common shared
    // closed sets; amounts against the Decimal(12,2) money shape. Company defaults
    // and requisition targets are NEVER promoted here — only the explicit payload.
    if (input.to === 'STARTED') {
      const terms = input.commercial_terms;
      if (!terms) {
        throw new AramoError(
          'PLACEMENT_START_COMMERCIAL_TERMS_REQUIRED',
          'Starting a placement requires the actual commercial terms (pay_rate_amount, bill_rate_amount, currency, rate_period)',
          422,
          { requestId, details: { placement_process_id: input.placement_process_id, reason: 'commercial_terms_required' } },
        );
      }
      if (!isIso4217Currency(terms.currency)) {
        throw new AramoError('VALIDATION_ERROR', 'commercial_terms.currency must be an active ISO-4217 code', 400, { requestId, details: { field: 'commercial_terms.currency' } });
      }
      if (!isRatePeriod(terms.rate_period)) {
        throw new AramoError('VALIDATION_ERROR', 'commercial_terms.rate_period is not a recognised rate period', 400, { requestId, details: { field: 'commercial_terms.rate_period' } });
      }
      if (!MONEY_12_2.test(terms.pay_rate_amount) || !MONEY_12_2.test(terms.bill_rate_amount)) {
        throw new AramoError('VALIDATION_ERROR', 'commercial_terms pay/bill must be a non-negative Decimal(12,2) money string', 400, { requestId, details: { field: 'commercial_terms.amount' } });
      }
      if (!input.recorded_by) {
        throw new AramoError('VALIDATION_ERROR', 'a recording principal (recorded_by) is required for commercial terms', 400, { requestId, details: { field: 'recorded_by' } });
      }
    } else if (input.commercial_terms != null) {
      throw new AramoError('VALIDATION_ERROR', 'commercial_terms may only be supplied on a transition to STARTED', 400, { requestId, details: { field: 'commercial_terms', to_state: input.to } });
    }

    // ONE transaction-level effective instant (Amendment A1-8): the ContractAssignment
    // start fact and the initial Assignment Rate Version effective_from share it, so
    // no per-layer wall-clock call introduces micro-drift.
    const startedAt = new Date();

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const u = (await tx.placementProcess.update({
          where: { id: input.placement_process_id },
          data: { state: input.to },
        })) as PlacementProcessRow;
        await tx.placementProcessEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            placement_process_id: input.placement_process_id,
            event_type: 'state_transition',
            event_payload: { from: current.state, to: input.to },
            // E3 — reason evidence columns. Null for a non-governed transition.
            // reason_detail (PII-bearing, tenant-owned) is persisted HERE only; it
            // is deliberately excluded from the outbox payload below (§13/C1).
            reason_code: evidence?.reason_code ?? null,
            reason_label_snapshot: evidence?.reason_label_snapshot ?? null,
            reason_detail: evidence?.reason_detail ?? null,
          },
        });
        // Transactional outbox (9-c-2): a placement.process.state_changed event
        // commits atomically with the state change. A rejected/illegal edge never
        // reaches here, so no event is written for it.
        //
        // E3 / C1 — for a governed terminal transition the outbox carries EXACTLY
        // reason_code + reason_label_snapshot alongside the existing to_state
        // (= target_state). It NEVER carries reason_detail, under ANY detail
        // policy: reason_detail is recruiter-authored free text about a named
        // individual and placement.OutboxEvent is append-only + immutable — the
        // same evidence/privacy class as offer_terms_summary (PR #574). A
        // downstream consumer holding placement_process_id retrieves tenant-owned
        // detail through the governed placement read surface, where a tenant reset
        // can remove it.
        await tx.outboxEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            event_type: OUTBOX_STATE_CHANGED,
            event_payload: {
              placement_process_id: input.placement_process_id,
              tenant_id: input.tenant_id,
              submittal_id: current.submittal_id,
              requisition_id: current.requisition_id,
              talent_record_id: current.talent_record_id,
              from_state: current.state,
              to_state: input.to,
              // Present only for a governed terminal transition; reason_detail is
              // NEVER included (C1).
              ...(evidence !== null
                ? { reason_code: evidence.reason_code, reason_label_snapshot: evidence.reason_label_snapshot }
                : {}),
              occurred_at: new Date().toISOString(),
            },
          },
        });
        // Track 4 / T4-A1 — the forward STARTED -> ContractAssignment path. When a
        // placement starts, its authoritative post-start assignment is created in
        // the SAME transaction (the §10 assignment/capacity atomicity foundation).
        // start fact = now; provenance FORWARD; lifecycle ACTIVE; org snapshot is
        // caller-supplied (no cross-schema read, §4). The unique
        // (tenant_id, placement_process_id) index is the idempotency floor.
        if (input.to === 'STARTED') {
          const ctx = input.assignment_context;
          const terms = input.commercial_terms as CommercialTermsInput;
          const assignmentId = uuidv7();
          await tx.contractAssignment.create({
            data: {
              id: assignmentId,
              tenant_id: input.tenant_id,
              placement_process_id: input.placement_process_id,
              submittal_id: current.submittal_id,
              requisition_id: current.requisition_id,
              talent_record_id: current.talent_record_id,
              started_at: startedAt,
              provenance: 'FORWARD',
              lifecycle_state: 'ACTIVE',
              company_id: ctx?.company_id ?? null,
              site_id: ctx?.site_id ?? null,
              company_department_id: ctx?.company_department_id ?? null,
            },
          });
          // Track 5 / T5-P1 — the INITIAL Assignment Rate Version, created in the
          // SAME transaction (Amendment A1: there is NO committed steady state with
          // a started FORWARD assignment lacking its initial actual terms).
          // effective_from = the SAME startedAt as the assignment start (A1-8).
          // Append-only; subsequent effective-dated versions are T6. Amounts are
          // passed as decimal strings straight to the Decimal(12,2) column (no float).
          const rateVersionId = uuidv7();
          await tx.assignmentRateVersion.create({
            data: {
              id: rateVersionId,
              tenant_id: input.tenant_id,
              contract_assignment_id: assignmentId,
              requisition_id: current.requisition_id,
              talent_record_id: current.talent_record_id,
              pay_rate_amount: terms.pay_rate_amount,
              bill_rate_amount: terms.bill_rate_amount,
              currency: terms.currency,
              rate_period: terms.rate_period,
              effective_from: startedAt,
              recorded_by: input.recorded_by as string,
              change_reason: null,
            },
          });
          // Atomic audit/outbox (Amendment A2 §8): identity/provenance ONLY — NO
          // pay/bill/spread/margin/markup/currency/rate_period. The outbox announces
          // that commercial state exists; the figures are served by the protected
          // read surface (T5-P2), never this append-only, non-reset-covered log.
          await tx.outboxEvent.create({
            data: {
              id: uuidv7(),
              tenant_id: input.tenant_id,
              event_type: OUTBOX_RATE_VERSION_CREATED,
              event_payload: {
                tenant_id: input.tenant_id,
                contract_assignment_id: assignmentId,
                assignment_rate_version_id: rateVersionId,
                requisition_id: current.requisition_id,
                talent_record_id: current.talent_record_id,
                effective_from: startedAt.toISOString(),
              },
            },
          });
        }
        return u;
      });
      return projectView(updated);
    } catch (err) {
      // Race-safe floor: the BEFORE UPDATE trigger rejected an illegal edge
      // (e.g. a concurrent move changed the from-state under us).
      if (isTransitionViolation(err)) {
        throw this.stateInvalid(current.state, input.to, requestId, input.placement_process_id);
      }
      throw err;
    }
  }

  // Track 4 / T4-C — end the ContractAssignment of a STARTED placement (the ONE
  // ratified assignment edge, ACTIVE -> ENDED). Post-start attrition/completion
  // lives HERE, not as a new PlacementProcess edge (T4-Q1 — STARTED stays
  // transition-terminal). Ending releases the one-live guard (G2) and, at T4-B2,
  // capacity. Only an ACTIVE assignment transitions; a no-op returns NOT_FOUND so
  // the caller cannot mistake an absent/already-ended assignment for a state flip.
  async endAssignment(
    input: { tenant_id: string; placement_process_id: string; end_reason: ContractAssignmentEndReason },
    requestId: string,
  ): Promise<void> {
    // §10 / T4-D — the state flip and its domain event commit atomically or not at
    // all: an assignment cannot end without its evidence, nor emit without ending.
    await this.prisma.$transaction(async (tx) => {
      const existing = (await tx.contractAssignment.findFirst({
        where: { tenant_id: input.tenant_id, placement_process_id: input.placement_process_id, lifecycle_state: 'ACTIVE' },
        select: { id: true, submittal_id: true, requisition_id: true, talent_record_id: true },
      })) as { id: string; submittal_id: string; requisition_id: string; talent_record_id: string } | null;
      if (existing === null) {
        throw new AramoError('NOT_FOUND', 'No active ContractAssignment to end', 404, {
          requestId,
          details: { placement_process_id: input.placement_process_id, reason: 'active_assignment_not_found' },
        });
      }
      await tx.contractAssignment.update({
        where: { id: existing.id },
        // The ratified ending reason is recorded structurally (COMPLETED /
        // WORKER_ENDED / CLIENT_ENDED), atomically with the state flip.
        data: { lifecycle_state: 'ENDED', end_reason: input.end_reason },
      });
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: OUTBOX_ASSIGNMENT_ENDED,
          event_payload: {
            assignment_id: existing.id,
            placement_process_id: input.placement_process_id,
            tenant_id: input.tenant_id,
            submittal_id: existing.submittal_id,
            requisition_id: existing.requisition_id,
            talent_record_id: existing.talent_record_id,
            end_reason: input.end_reason,
            occurred_at: new Date().toISOString(),
          },
        },
      });
    });
  }

  // Track 4 / T4-D (assignment:read) — the authoritative assignment-state read for
  // a placement. Returns null when no ContractAssignment exists for the placement
  // (a coherent absence, NOT a fabricated row). Visibility is enforced by the
  // caller loading the placement through findByIdForActor FIRST (house pattern).
  // The unique (tenant_id, placement_process_id) index makes this at-most-one.
  async findAssignmentByPlacement(
    tenant_id: string,
    placement_process_id: string,
  ): Promise<ContractAssignmentView | null> {
    const row = (await this.prisma.contractAssignment.findFirst({
      where: { tenant_id, placement_process_id },
      select: {
        id: true,
        placement_process_id: true,
        submittal_id: true,
        requisition_id: true,
        talent_record_id: true,
        started_at: true,
        provenance: true,
        lifecycle_state: true,
        end_reason: true,
      },
    })) as ContractAssignmentView | null;
    return row;
  }

  async findById(tenant_id: string, id: string): Promise<PlacementProcessView | null> {
    const row = (await this.prisma.placementProcess.findFirst({
      where: { tenant_id, id },
    })) as PlacementProcessRow | null;
    return row === null ? null : projectView(row);
  }

  // E1-d / D-3 — visibility-scoped item read. Placement inherits its
  // requisition's visibility: the actor sees a placement only when its
  // requisition_id is in the pre-resolved visible set (VisibilityResolver,
  // via the controller). null ⇒ see_all_requisition ⇒ unrestricted (falls
  // back to the tenant-only findById). A tenant-present-but-not-visible row
  // returns null here → the controller maps null to 404 (never 403): the
  // scope passed, so existence must not be disclosed. Mirrors
  // PipelineRepository.findByIdForActor (libs/pipeline).
  async findByIdForActor(args: {
    tenant_id: string;
    id: string;
    visible_requisition_ids: ReadonlySet<string> | null;
  }): Promise<PlacementProcessView | null> {
    if (args.visible_requisition_ids !== null) {
      const row = (await this.prisma.placementProcess.findFirst({
        where: {
          tenant_id: args.tenant_id,
          id: args.id,
          requisition_id: { in: Array.from(args.visible_requisition_ids) },
        },
      })) as PlacementProcessRow | null;
      return row === null ? null : projectView(row);
    }
    return this.findById(args.tenant_id, args.id);
  }

  // E1-d / Scope A — the placement collection read. Tenant-isolated and
  // actor-visibility-scoped over the three indexed axes (requisition_id,
  // submittal_id, talent_record_id — the init-migration indexes). Ordering is
  // deterministic with a STABLE tie-breaker (created_at desc, then id asc) so
  // the board renders the same order across equal-timestamp rows and across
  // pages. Bounded at 200 (house cap). The projection is PlacementProcessView,
  // which carries NO reason fields — reason evidence never enters a collection
  // response (D-1/D-2; asserted by Proof 4). No new persistence.
  async listForActor(args: {
    tenant_id: string;
    visible_requisition_ids: ReadonlySet<string> | null;
    requisition_id?: string;
    submittal_id?: string;
    talent_record_id?: string;
    limit?: number;
  }): Promise<PlacementProcessView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const where: Record<string, unknown> = { tenant_id: args.tenant_id };
    if (args.visible_requisition_ids !== null) {
      where['requisition_id'] = { in: Array.from(args.visible_requisition_ids) };
    }
    if (args.requisition_id !== undefined) {
      // Narrow to ONE requisition; AND with the visibility set (never widen).
      if (
        args.visible_requisition_ids !== null &&
        !args.visible_requisition_ids.has(args.requisition_id)
      ) {
        return [];
      }
      where['requisition_id'] = args.requisition_id;
    }
    if (args.submittal_id !== undefined) {
      where['submittal_id'] = args.submittal_id;
    }
    if (args.talent_record_id !== undefined) {
      where['talent_record_id'] = args.talent_record_id;
    }
    const rows = (await this.prisma.placementProcess.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      take: limit,
    })) as PlacementProcessRow[];
    return rows.map(projectView);
  }

  private alreadyLive(input: CreatePlacementInput, requestId: string, existingId: string | undefined): AramoError {
    return new AramoError(
      'PLACEMENT_ALREADY_LIVE',
      'A live PlacementProcess already exists for this (tenant, submittal) pair',
      409,
      {
        requestId,
        details: {
          tenant_id: input.tenant_id,
          submittal_id: input.submittal_id,
          existing_placement_process_id: existingId,
        },
      },
    );
  }

  // E4 — map a replacement-linkage rejection to the single registered code
  // PLACEMENT_REPLACEMENT_INVALID (422), with details.reason as the discriminator
  // (the E7 RESTRICTION_INVALID / E3 PLACEMENT_REASON_INVALID precedent). Raised
  // BEFORE the one-live guard and the transaction, so a rejected replacement
  // leaves the state, event log, and outbox untouched. Cross-tenant and
  // cross-requisition both surface as predecessor_not_found (least-visibility).
  private replacementInvalid(
    reason: 'predecessor_not_found' | 'predecessor_not_terminal',
    input: CreatePlacementInput,
    replacesId: string,
    requestId: string,
  ): AramoError {
    return new AramoError('PLACEMENT_REPLACEMENT_INVALID', `Invalid placement replacement: ${reason}`, 422, {
      requestId,
      details: {
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        requisition_id: input.requisition_id,
        replaces_placement_process_id: replacesId,
        reason,
      },
    });
  }

  // E3 — map a reason-classification rejection to the single registered code
  // PLACEMENT_REASON_INVALID (422), with details.reason as the discriminator (the
  // E7 RESTRICTION_INVALID precedent). Raised BEFORE the transaction, so a reason
  // refusal leaves the state, event log, and outbox untouched.
  private reasonInvalid(
    rejection: Extract<ReasonClassification, { ok: false }>,
    from: PlacementState,
    input: TransitionPlacementInput,
    requestId: string,
  ): AramoError {
    return new AramoError('PLACEMENT_REASON_INVALID', `Invalid placement reason evidence: ${rejection.reason}`, 422, {
      requestId,
      details: {
        placement_process_id: input.placement_process_id,
        from_state: from,
        to_state: input.to,
        reason: rejection.reason,
        ...(rejection.reason_code !== undefined ? { reason_code: rejection.reason_code } : {}),
        ...(rejection.length !== undefined ? { detail_length: rejection.length } : {}),
      },
    });
  }

  private stateInvalid(
    from: PlacementState,
    to: PlacementState,
    requestId: string,
    placement_process_id: string,
  ): AramoError {
    return new AramoError(
      'PLACEMENT_STATE_INVALID',
      `Illegal PlacementProcess state transition: ${from} -> ${to}`,
      422,
      { requestId, details: { placement_process_id, from_state: from, to_state: to } },
    );
  }
}
