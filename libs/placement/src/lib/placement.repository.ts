import { Injectable, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { insertPolicyDecisionRecordInTx } from '@aramo/policy-store';
import { AramoError, isIso4217Currency, isRatePeriod } from '@aramo/common';

import { Prisma } from '../../prisma/generated/client/client.js';

import { PrismaService } from './prisma/prisma.service.js';
import { deriveCommercialMetrics } from './commercial/commercial-metrics.js';
import { isAssignmentEndingSoon } from './assignment-ending-soon.js';
import {
  canTransition,
  DUPLICATE_GUARD_INACTIVE,
  INITIAL_STATE,
  isPlacementGuardReleased,
  type PlacementState,
  type RemedyPolicy,
} from './lifecycle/placement-lifecycle.js';
import {
  classifyTransitionReason,
  type ReasonClassification,
  type ReasonEvidence,
} from './reasons/placement-reason-registry.js';
import {
  ASSIGNMENT_ENDED_CANCELLATION_REASON,
  isUserCancellationReasonCode,
} from './reasons/commercial-cancellation-reasons.js';
import {
  governingCommercialProposalAction,
  isCommercialApprovalAuthorityAction,
  COMMERCIAL_PROPOSAL_INITIAL_STATE,
  type CommercialApprovalAction,
} from './lifecycle/commercial-approval-lifecycle.js';
import { CommercialApprovalPolicyService } from './policy/commercial-approval-policy.service.js';
import { validateGuaranteeTerms, parseCalendarDate } from './permanent/guarantee-validation.js';
import {
  OUTBOX_PERMANENT_PLACEMENT_CREATED,
  OUTBOX_PERMANENT_PLACEMENT_GUARANTEE_ACTIVE,
} from './permanent/permanent-placement.repository.js';
import {
  resolveEffectiveTermRow,
  resolvedTermsFromRow,
  OUTBOX_GUARANTEE_TERMS_APPLIED,
} from './permanent/guarantee-term.repository.js';
import type {
  AssignmentCommercialView,
  AssignmentExtensionReason,
  AssignmentExtensionSource,
  CommercialMarginComparison,
  CommercialMarginSide,
  CommercialProposalView,
  CommercialTermsInput,
  ContractAssignmentEndReason,
  ContractAssignmentView,
  CreatePlacementInput,
  PlacementKind,
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
  offer_id: string | null;
  offered_at: Date;
  proposed_start_date: Date | null;
  offer_expires_at: Date | null;
  client_offer_reference: string | null;
  offer_terms_summary: string | null;
  // Track 7 / T7-P1 — the persisted branch fact, read at the STARTED handoff.
  placement_kind: PlacementKind | null;
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
    offer_id: row.offer_id,
    offered_at: row.offered_at,
    proposed_start_date: row.proposed_start_date,
    offer_expires_at: row.offer_expires_at,
    client_offer_reference: row.client_offer_reference,
    offer_terms_summary: row.offer_terms_summary,
    placement_kind: row.placement_kind,
    created_at: row.created_at,
  };
}

// The placement OutboxEvent types (9-c-2). Generic lifecycle events, NOT one per
// outcome. Aggregate identity lives in the payload (house pattern).
const OUTBOX_CREATED = 'placement.process.created';
const OUTBOX_STATE_CHANGED = 'placement.process.state_changed';
// Track 4 / T4-D — the ContractAssignment ending domain event.
const OUTBOX_ASSIGNMENT_ENDED = 'placement.assignment.ended';
// Slice #3 (Assignment-Extension, R-EXTEND-TXN) — the extend domain event. Identity
// + the window that moved; no commercial figures (house pattern).
const OUTBOX_ASSIGNMENT_EXTENDED = 'placement.assignment.extended';
// Track 5 / T5-P1 — the initial Assignment Rate Version creation domain event.
// Identity/provenance ONLY (Amendment A2 §8): NEVER pay/bill/spread/margin/markup/
// currency/rate_period. It announces that commercial state exists; the figures are
// served by the protected read surface (T5-P2), never the append-only, non-reset-
// covered outbox.
const OUTBOX_RATE_VERSION_CREATED = 'placement.assignment.rate_version.created';
// Track 6 / T6-B3 — the AssignmentRateVersion CANCELLATION domain event. Emitted
// exactly once per version cancelled: once for an explicit user cancellation, and
// once per future version reconciled-as-cancelled at assignment END. Identity/
// provenance ONLY — NEVER pay/bill/spread/margin/markup/currency/rate_period
// (the append-only, non-reset-covered outbox convention shared with rate_version.
// created); the cancellation reason + original effective_from are provenance, not money.
const OUTBOX_RATE_VERSION_CANCELLED = 'placement.assignment.rate_version.cancelled';
// Track 7 / T7-PX — the dedicated Contract-to-Permanent conversion domain event, so
// downstream consumers see the lineage as ONE semantic act (not an END adjacent to a
// permanent CREATE). Identity + governed lineage facts ONLY — NO PII, NO pay/bill/
// margin/markup, no free text (the append-only, non-reset-covered outbox convention).
const OUTBOX_ASSIGNMENT_CONVERTED_TO_PERMANENT = 'placement.assignment.converted_to_permanent';

// Track 5 / T5-P1 — a decimal money string (never a float): up to 10 integer
// digits and up to 2 fractional, matching the Decimal(12,2) column. Defensive
// repository guard (the HTTP DTO also validates) — the repo is called directly by
// integration proofs, so the write boundary must not trust the amount format.
const MONEY_12_2 = /^\d{1,10}(\.\d{1,2})?$/;

// Track 7 / T7-PX — the Contract-to-Permanent conversion result. Carries enough for the
// caller (and the FE) to navigate to the NEW permanent PlacementProcess (§10). `replayed`
// is true when an already-converted source returns its existing target (idempotent §11).
export interface ConvertToPermanentResult {
  readonly replayed: boolean;
  readonly source_placement_process_id: string;
  readonly source_contract_assignment_id: string;
  readonly target_placement_process_id: string;
  readonly target_permanent_placement_id: string;
}

interface ConversionLineageRow {
  source_placement_process_id: string;
  source_contract_assignment_id: string;
  target_placement_process_id: string;
  target_permanent_placement_id: string;
}

function conversionResult(row: ConversionLineageRow, replayed: boolean): ConvertToPermanentResult {
  return {
    replayed,
    source_placement_process_id: row.source_placement_process_id,
    source_contract_assignment_id: row.source_contract_assignment_id,
    target_placement_process_id: row.target_placement_process_id,
    target_permanent_placement_id: row.target_permanent_placement_id,
  };
}

// The conversion-lineage unique keys are the idempotency race floor. A collision is
// Prisma P2002 or the raw partial-index message (PrismaPg surfaces raw violations at the
// driver-adapter layer, NOT meta.target — the T7-P2 lesson), so match defensively.
function isConversionLineageDuplicate(err: unknown): boolean {
  if (err !== null && typeof err === 'object') {
    const e = err as { code?: string; meta?: { modelName?: string; target?: unknown }; message?: string };
    if (e.code === 'P2002') {
      const t = e.meta?.target;
      const target = Array.isArray(t) ? t.join(',') : String(t ?? '');
      return (
        e.meta?.modelName === 'PermanentPlacementConversionLineage' ||
        target.includes('source_contract_assignment_id') ||
        target.includes('source_placement_process_id')
      );
    }
    if (typeof e.message === 'string' && e.message.includes('PermanentPlacementConversionLineage')) return true;
  }
  return false;
}

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

// Track 7 / T7-P1 — a PermanentPlacement (tenant_id, placement_process_id) unique
// violation, translated to the exact-name PERMANENT_PLACEMENT_ALREADY_EXISTS
// (never a generic P2002 catch). Prisma 7 + PrismaPg surfaces the raw constraint at
// meta.driverAdapterError.cause.originalMessage / .constraint.index, NOT meta.target
// — match on the index NAME across both the top-level message and the driver cause.
function isPermanentPlacementDuplicate(err: unknown): boolean {
  const NAME = 'PermanentPlacement_tenant_process_key';
  if (errMessage(err).includes(NAME)) return true;
  if (typeof err !== 'object' || err === null) return false;
  const cause = (
    err as { meta?: { driverAdapterError?: { cause?: { originalMessage?: unknown; constraint?: { index?: unknown } } } } }
  ).meta?.driverAdapterError?.cause;
  const orig = typeof cause?.originalMessage === 'string' ? cause.originalMessage : '';
  if (orig.includes(NAME)) return true;
  const idx = cause?.constraint?.index;
  return typeof idx === 'string' && idx.includes(NAME);
}

// Track 6 / T6-B2 — the AssignmentRateVersion DB constraints raise by CONSTRAINT
// NAME, which Prisma 7 (PrismaPg adapter) surfaces NOT at `meta.target` but at
// `meta.driverAdapterError.cause.originalMessage` / `.constraint` (the raw
// partial-index / exclusion shape — the E6 P2002 trap). A unique 23505 via the
// client MAY also populate `meta.target`. Gather every available message string so the
// named-constraint match is robust across shapes; NEVER a generic P2002/23505/
// 23P01 catch (the PIPELINE_EPISODE_ALREADY_LIVE / REQUISITION_EXTERNAL_IDENTITY_
// CONFLICT contract). The overlap EXCLUDE (23P01) has no Prisma code at all.
function constraintText(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const e = err as {
    message?: unknown;
    meta?: { target?: unknown; driverAdapterError?: { cause?: { originalMessage?: unknown; constraint?: unknown } } };
  };
  const parts: string[] = [];
  if (typeof e.message === 'string') parts.push(e.message);
  if (Array.isArray(e.meta?.target)) parts.push(e.meta!.target!.join(','));
  const cause = e.meta?.driverAdapterError?.cause;
  if (cause) {
    if (typeof cause.originalMessage === 'string') parts.push(cause.originalMessage);
    const c = cause.constraint as { index?: unknown; fields?: unknown } | string | undefined;
    if (typeof c === 'string') parts.push(c);
    else if (c && typeof c === 'object') {
      if (typeof c.index === 'string') parts.push(c.index);
      if (Array.isArray(c.fields)) parts.push(c.fields.join(','));
    }
  }
  return parts.join(' | ');
}
function isWindowOverlapViolation(err: unknown): boolean {
  return constraintText(err).includes('AssignmentRateVersion_no_window_overlap_excl');
}
function isDuplicateEffectiveFromViolation(err: unknown): boolean {
  return constraintText(err).includes('AssignmentRateVersion_tenant_assignment_effective_key');
}
// Slice #4 — the CommercialRevisionProposal one-live partial-unique. Matched by
// index NAME across the Prisma-7 shapes (constraintText gathers driverAdapterError
// too — the raw partial-index P2002 does NOT populate meta.target). NEVER a
// generic P2002 catch (the OFFER_ALREADY_LIVE contract at the proposal layer).
function isProposalOneLiveViolation(err: unknown): boolean {
  return constraintText(err).includes('CommercialRevisionProposal_one_live_idx');
}
// Slice #4 — one margin side (current OR proposed) via the canonical
// deriveCommercialMetrics (never a reimplementation, never stored).
function sideOf(
  pay: Prisma.Decimal,
  bill: Prisma.Decimal,
  currency: string,
  ratePeriod: string,
): CommercialMarginSide {
  const m = deriveCommercialMetrics(pay, bill);
  return {
    pay_rate_amount: pay.toFixed(2),
    bill_rate_amount: bill.toFixed(2),
    currency,
    rate_period: ratePeriod,
    spread_amount: m.spread_amount,
    margin_percent: m.margin_percent,
    markup_percent: m.markup_percent,
  };
}

// PlacementRepository — create + governed transition + event persistence for
// the PlacementProcess spine (Track 3 / E1-a §9).
//
// The DB trigger is the authority (the one-live-attempt guard and the 14-edge
// matrix are enforced there, generated from the registry). The repository adds
// the dominant submittal/selection pattern: a pre-emptive application-layer
// guard that returns a structured domain error BEFORE the SQL, with the trigger
// as the race-safe floor caught by message substring. Raw Postgres exceptions
// are never surfaced to the caller (§ error handling).
// Track 7 / T7-P3 — the resolved permanent-activation snapshot (directive §3.4 / §7). The
// employment start is always a per-placement fact; duration/remedy/exposure/currency come
// from the canonical stored guarantee-term version when one is effective, else from the
// legacy explicit guarantee_terms. The four *_source*/version fields are the copied
// provenance (NULL for the legacy path).
interface PermanentActivation {
  readonly guarantee_start_date: Date;
  readonly guarantee_duration_days: number;
  readonly guarantee_end_date: Date;
  readonly remedy_policy: RemedyPolicy;
  readonly guarantee_exposure_amount: string;
  readonly guarantee_exposure_currency: string;
  readonly terms_source: string;
  readonly recorded_by: string;
  readonly guarantee_term_version_id: string | null;
  readonly guarantee_terms_source_type: string | null;
  readonly guarantee_terms_source_reference: string | null;
  readonly guarantee_terms_source_version: string | null;
}

function addUtcDaysLocal(start: Date, days: number): Date {
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + days);
  return end;
}

// Resolve the PERMANENT activation snapshot BEFORE any mutation (directive §3.4). Precedence:
// exactly one effective stored version => copy it (canonical); a conflicting explicit input =>
// reject; 0 stored + legacy explicit terms => legacy path; 0 stored + no explicit terms => fail
// closed; >1 effective => fail closed ambiguous (in resolveEffectiveTermRow). No live-read after.
async function resolvePermanentActivation(
  prisma: PrismaService,
  requisition_id: string,
  input: TransitionPlacementInput,
  requestId: string,
): Promise<PermanentActivation> {
  const recorded_by = input.recorded_by;
  if (!recorded_by) {
    throw new AramoError('VALIDATION_ERROR', 'a recording principal (recorded_by) is required to start a permanent placement', 400, {
      requestId,
      details: { field: 'recorded_by' },
    });
  }

  // Employment start (per-placement fact): the legacy bundle's start when present, else the
  // standalone guarantee_start_date. Required either way.
  const startStr = input.guarantee_terms?.guarantee_start_date ?? input.guarantee_start_date ?? null;
  if (startStr == null) {
    throw new AramoError('PERMANENT_PLACEMENT_TERMS_REQUIRED', 'a permanent start requires guarantee_start_date (or the legacy guarantee_terms)', 422, {
      requestId,
      details: { reason: 'guarantee_start_date_required' },
    });
  }
  const start = parseCalendarDate(startStr);
  if (start === null) {
    throw new AramoError('PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID', 'guarantee_start_date is not a valid calendar date', 422, {
      requestId,
      details: { reason: 'start_date_invalid', guarantee_start_date: startStr },
    });
  }

  // Stored terms are canonical when an effective version exists (§3.4).
  const storedRow = await resolveEffectiveTermRow(prisma, input.tenant_id, requisition_id, start, requestId);
  if (storedRow !== null) {
    const resolved = resolvedTermsFromRow(storedRow);
    // A conflicting explicit input, if ALSO supplied, is rejected (never silently ignored).
    if (input.guarantee_terms != null) {
      const explicit = validateGuaranteeTerms(input.guarantee_terms, recorded_by, requestId);
      const conflict =
        explicit.guarantee_duration_days !== resolved.guarantee_duration_days ||
        explicit.remedy_policy !== resolved.remedy_policy ||
        Number(explicit.guarantee_exposure_amount).toFixed(2) !== resolved.guarantee_exposure_amount ||
        explicit.guarantee_exposure_currency !== resolved.currency;
      if (conflict) {
        throw new AramoError('VALIDATION_ERROR', 'the supplied guarantee_terms conflict with the canonical stored guarantee-term version', 400, {
          requestId,
          details: { reason: 'explicit_terms_conflict_with_stored', requisition_id, guarantee_term_version_id: resolved.guarantee_term_version_id },
        });
      }
    }
    return {
      guarantee_start_date: start,
      guarantee_duration_days: resolved.guarantee_duration_days,
      guarantee_end_date: addUtcDaysLocal(start, resolved.guarantee_duration_days),
      remedy_policy: resolved.remedy_policy,
      guarantee_exposure_amount: resolved.guarantee_exposure_amount,
      guarantee_exposure_currency: resolved.currency,
      terms_source: resolved.source_type,
      recorded_by,
      guarantee_term_version_id: resolved.guarantee_term_version_id,
      guarantee_terms_source_type: resolved.source_type,
      guarantee_terms_source_reference: resolved.source_reference,
      guarantee_terms_source_version: resolved.source_version,
    };
  }

  // No stored version: legacy explicit P1 path when full terms are present, else fail closed.
  if (input.guarantee_terms == null) {
    throw new AramoError('PERMANENT_PLACEMENT_TERMS_NOT_FOUND', 'no guarantee-term version is effective for the requisition and no explicit guarantee_terms were supplied', 404, {
      requestId,
      details: { requisition_id, reason: 'no_stored_terms_no_explicit_input' },
    });
  }
  const legacy = validateGuaranteeTerms(input.guarantee_terms, recorded_by, requestId);
  return {
    guarantee_start_date: legacy.guarantee_start_date,
    guarantee_duration_days: legacy.guarantee_duration_days,
    guarantee_end_date: legacy.guarantee_end_date,
    remedy_policy: legacy.remedy_policy,
    guarantee_exposure_amount: legacy.guarantee_exposure_amount,
    guarantee_exposure_currency: legacy.guarantee_exposure_currency,
    terms_source: legacy.terms_source,
    recorded_by: legacy.recorded_by,
    guarantee_term_version_id: null,
    guarantee_terms_source_type: null,
    guarantee_terms_source_reference: null,
    guarantee_terms_source_version: null,
  };
}

@Injectable()
export class PlacementRepository {
  // The Commercial Approval policy gate (R-POLICY) is OPTIONAL at construction so
  // the 13 `new PlacementRepository(prisma)` proof sites that never touch proposals
  // are unaffected. Production wires it via placement.module. A proposal AUTHORITY
  // transition reached without it throws (fail-closed — never a silent ALLOW).
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly commercialApprovalPolicy?: CommercialApprovalPolicyService,
  ) {}

  // Create a new PlacementProcess. The placement is created downstream of an
  // accepted offer (owned by the Offer aggregate), so the initial state is
  // PRE_START (§4). Rejects a second LIVE attempt for the same
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

    // Offer Lifecycle (D6, R-PRECEDENCE) — the placement is created DOWNSTREAM of
    // an ACCEPTED offer. offer_id is REQUIRED and must reference an offer in this
    // tenant in state ACCEPTED (the same create-time referential-integrity idiom
    // as E4's replaces_placement_process_id; there is no FK, §7.3). A missing
    // offer_id, or one that does not resolve to an ACCEPTED offer, is refused
    // before the live-guard-cleared INSERT.
    const offerId = input.offer_id ?? null;
    if (offerId === null) {
      throw new AramoError('VALIDATION_ERROR', 'offer_id is required — a placement is created from an ACCEPTED offer', 400, {
        requestId,
        details: { field: 'offer_id', reason: 'offer_id_required' },
      });
    }
    const acceptedOffer = await this.prisma.offer.findFirst({
      where: { tenant_id: input.tenant_id, id: offerId, state: 'ACCEPTED' },
      select: { id: true },
    });
    if (acceptedOffer === null) {
      throw new AramoError('VALIDATION_ERROR', 'placement requires the referenced offer to be ACCEPTED', 400, {
        requestId,
        details: { field: 'offer_id', reason: 'offer_not_accepted', offer_id: offerId },
      });
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
            // Offer Lifecycle (D6) — the ACCEPTED offer this placement derives from.
            offer_id: offerId,
            offered_at,
            proposed_start_date: input.proposed_start_date ?? null,
            offer_expires_at: input.offer_expires_at ?? null,
            client_offer_reference: input.client_offer_reference ?? null,
            offer_terms_summary: input.offer_terms_summary ?? null,
            // E4 — replacement lineage, written once at INSERT (§4/§5).
            replaces_placement_process_id: replacesId,
            // Track 7 / T7-P1 — the permanent-vs-contract branch fact, written
            // once at INSERT (§3.1). NULL when the caller is kind-agnostic
            // (legacy/CONTRACT-compatible at STARTED); an explicit PERMANENT is
            // required to later start a permanent placement.
            placement_kind: input.placement_kind ?? null,
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

    // Track 7 / T7-P1 — the persisted branch fact decides which post-start
    // aggregate STARTED materialises (§3.1). PERMANENT -> PermanentPlacement (the
    // guarantee path); CONTRACT or legacy NULL -> ContractAssignment (the existing
    // path, backward-compatible). Read from the AGGREGATE, never a transient flag.
    const isStart = input.to === 'STARTED';
    const isPermanentStart = isStart && current.placement_kind === 'PERMANENT';

    // guarantee_terms belong ONLY to the PERMANENT start seam — the symmetric
    // mirror of commercial_terms. Supplying them on a CONTRACT/NULL start or a
    // non-STARTED target is a fail-closed misuse: a placement whose kind is not an
    // explicit PERMANENT cannot be started permanent (§3.1 — the branch is proven
    // from the persisted fact, never inferred from the presence of terms).
    if (input.guarantee_terms != null && !isPermanentStart) {
      throw new AramoError('VALIDATION_ERROR', 'guarantee_terms may only be supplied on a transition to STARTED of a PERMANENT placement', 400, {
        requestId,
        details: { field: 'guarantee_terms', to_state: input.to, placement_kind: current.placement_kind },
      });
    }
    if (input.guarantee_start_date != null && !isPermanentStart) {
      throw new AramoError('VALIDATION_ERROR', 'guarantee_start_date may only be supplied on a transition to STARTED of a PERMANENT placement', 400, {
        requestId,
        details: { field: 'guarantee_start_date', to_state: input.to, placement_kind: current.placement_kind },
      });
    }

    // Track 7 / T7-P3 — resolve the governed activation snapshot BEFORE the transaction
    // (fail-closed, ZERO mutation). Stored guarantee-term versions are canonical when one is
    // effective as-of the employment start; else the legacy explicit guarantee_terms; else
    // fail closed (§3.4). Copy-at-activation — the snapshot is frozen, no live-read afterward.
    const permanentActivation = isPermanentStart
      ? await resolvePermanentActivation(this.prisma, current.requisition_id, input, requestId)
      : null;

    // Track 4 / T4-A1 — a CONTRACT transition to STARTED materialises the
    // authoritative ContractAssignment, whose FORWARD provenance requires a company
    // snapshot (the DB CHECK). Validate the caller supplied it BEFORE the tx, so a
    // missing context is a clean 422, never a raw check_violation rollback (§4: the
    // org snapshot is caller-supplied — placement performs no cross-schema read).
    // NOT required for a PERMANENT start (no ContractAssignment is minted — §6).
    if (isStart && !isPermanentStart && !input.assignment_context?.company_id) {
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
    // (Amendment A1-3). Commercial terms belong ONLY to the FORWARD CONTRACT
    // assignment-start seam: REQUIRED for a CONTRACT STARTED, REJECTED for a
    // PERMANENT start (which mints no AssignmentRateVersion — §6) and for every
    // other target (never silently discarded). currency/rate_period are checked
    // against the libs/common shared closed sets; amounts against the Decimal(12,2)
    // money shape. Company defaults and requisition targets are NEVER promoted here.
    if (isStart && !isPermanentStart) {
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
      throw new AramoError('VALIDATION_ERROR', 'commercial_terms may only be supplied on a transition to STARTED of a CONTRACT placement', 400, { requestId, details: { field: 'commercial_terms', to_state: input.to, placement_kind: current.placement_kind } });
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
        // Track 7 / T7-P1 — the PERMANENT STARTED -> PermanentPlacement path. When
        // a PERMANENT placement starts, its first-class post-start PermanentPlacement
        // is created in the SAME transaction (§6), in GUARANTEE_ACTIVE, carrying the
        // immutable guarantee snapshot validated above. NO ContractAssignment and NO
        // AssignmentRateVersion are minted on this branch (§6 / §3.2 — branch
        // exclusivity). The unique (tenant_id, placement_process_id) index is the
        // idempotency + exclusivity floor (a replay cannot double-insert, and a
        // placement never materialises both a ContractAssignment and a
        // PermanentPlacement). Append-only event + transactional outbox, PII-free.
        if (isPermanentStart) {
          const act = permanentActivation as NonNullable<typeof permanentActivation>;
          const permanentId = uuidv7();
          await tx.permanentPlacement.create({
            data: {
              id: permanentId,
              tenant_id: input.tenant_id,
              placement_process_id: input.placement_process_id,
              submittal_id: current.submittal_id,
              requisition_id: current.requisition_id,
              talent_record_id: current.talent_record_id,
              lifecycle_state: 'GUARANTEE_ACTIVE',
              guarantee_start_date: act.guarantee_start_date,
              guarantee_duration_days: act.guarantee_duration_days,
              guarantee_end_date: act.guarantee_end_date,
              remedy_policy: act.remedy_policy,
              guarantee_exposure_amount: act.guarantee_exposure_amount,
              guarantee_exposure_currency: act.guarantee_exposure_currency,
              terms_source: act.terms_source,
              recorded_by: act.recorded_by,
              // T7-P3 — copy-at-activation provenance (NULL for the legacy path); frozen by
              // the snapshot-immutability trigger.
              guarantee_term_version_id: act.guarantee_term_version_id,
              guarantee_terms_source_type: act.guarantee_terms_source_type,
              guarantee_terms_source_reference: act.guarantee_terms_source_reference,
              guarantee_terms_source_version: act.guarantee_terms_source_version,
            },
          });
          // Append-only activation event (from null -> GUARANTEE_ACTIVE).
          await tx.permanentPlacementEvent.create({
            data: {
              id: uuidv7(),
              tenant_id: input.tenant_id,
              permanent_placement_id: permanentId,
              event_type: 'state_transition',
              event_payload: { from: null, to: 'GUARANTEE_ACTIVE' },
            },
          });
          // Two governed outbox events (§12): the aggregate creation and its
          // guarantee activation. Identity + governed window facts ONLY — NO PII,
          // NO pay/bill/margin/markup, no free-text notes. (The exposure amount is
          // deliberately withheld from the append-only, non-reset-covered outbox,
          // mirroring the rate_version.created identity-only convention.)
          const permanentOutboxPayload = {
            tenant_id: input.tenant_id,
            permanent_placement_id: permanentId,
            placement_process_id: input.placement_process_id,
            submittal_id: current.submittal_id,
            requisition_id: current.requisition_id,
            talent_record_id: current.talent_record_id,
            lifecycle_state: 'GUARANTEE_ACTIVE',
            guarantee_start_date: act.guarantee_start_date.toISOString().slice(0, 10),
            guarantee_end_date: act.guarantee_end_date.toISOString().slice(0, 10),
            remedy_policy: act.remedy_policy,
            occurred_at: startedAt.toISOString(),
          };
          await tx.outboxEvent.create({
            data: { id: uuidv7(), tenant_id: input.tenant_id, event_type: OUTBOX_PERMANENT_PLACEMENT_CREATED, event_payload: permanentOutboxPayload },
          });
          await tx.outboxEvent.create({
            data: { id: uuidv7(), tenant_id: input.tenant_id, event_type: OUTBOX_PERMANENT_PLACEMENT_GUARANTEE_ACTIVE, event_payload: permanentOutboxPayload },
          });
          // T7-P3 — when a stored guarantee-term version was applied, emit the governed
          // "applied" event (§9). Safe payload only: identity + version id + source_type; NO
          // exposure amount, source_reference, source_version, free text, or PII.
          if (act.guarantee_term_version_id !== null) {
            await tx.outboxEvent.create({
              data: {
                id: uuidv7(),
                tenant_id: input.tenant_id,
                event_type: OUTBOX_GUARANTEE_TERMS_APPLIED,
                event_payload: {
                  tenant_id: input.tenant_id,
                  requisition_id: current.requisition_id,
                  permanent_placement_id: permanentId,
                  guarantee_term_version_id: act.guarantee_term_version_id,
                  source_type: act.guarantee_terms_source_type,
                  occurred_at: startedAt.toISOString(),
                },
              },
            });
          }
        } else if (input.to === 'STARTED') {
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
              // Slice #3 (R-INITIAL-END) — the assignment-owned planned end,
              // captured at the STARTED handoff. Nullable in the repo primitive
              // (backfill-safe); the HTTP operation enforces presence.
              expected_end_at:
                ctx?.expected_end_at != null ? new Date(ctx.expected_end_at) : null,
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
      // Track 7 / T7-P1 — race-safe branch-exclusivity/idempotency floor: two
      // concurrent PERMANENT starts that both pass the pre-check collide on the
      // (tenant, placement_process_id) unique key. Translate to the exact-name 409.
      if (isPermanentStart && isPermanentPlacementDuplicate(err)) {
        throw new AramoError('PERMANENT_PLACEMENT_ALREADY_EXISTS', 'a PermanentPlacement already exists for this placement', 409, {
          requestId,
          details: { placement_process_id: input.placement_process_id, reason: 'permanent_placement_already_exists' },
        });
      }
      throw err;
    }
  }

  // Track 4 / T4-C — end the ContractAssignment of a STARTED placement (the ONE
  // ratified assignment edge, ACTIVE -> ENDED). Post-start attrition/completion
  // L7-C — the canonical commercial transaction instant. Postgres now() is
  // transaction-stable (returns the tx start time), and the B3 future-boundary
  // RE-OPEN trigger gates on now(); resolving the app-side reconciliation instant
  // from the SAME database clock removes any app-server-vs-DB skew at END / CONVERT /
  // cancel window reconciliation (recon D-3). One authoritative model: absolute UTC
  // TIMESTAMPTZ, half-open [from,to), NULL = +infinity, no backdating. (Guarantee
  // DATE semantics on PermanentPlacement are a deliberately separate model, untouched.)
  private async commercialTxInstant(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRawUnsafe<Array<{ now: Date }>>(`SELECT now() AS "now"`);
    const first = rows[0];
    if (first === undefined) {
      throw new Error('placement: SELECT now() returned no row');
    }
    return first.now;
  }

  // lives HERE, not as a new PlacementProcess edge (T4-Q1 — STARTED stays
  // transition-terminal). Ending releases the one-live guard (G2) and, at T4-B2,
  // capacity. Only an ACTIVE assignment transitions; a no-op returns NOT_FOUND so
  // the caller cannot mistake an absent/already-ended assignment for a state flip.
  async endAssignment(
    input: {
      tenant_id: string;
      placement_process_id: string;
      end_reason: ContractAssignmentEndReason;
      // T6-B3 §16 — the acting principal (JWT sub) recorded as cancelled_by on
      // every commercial version END reconciliation withdraws (ASSIGNMENT_ENDED).
      ended_by: string;
    },
    requestId: string,
  ): Promise<void> {
    // §10 / T4-D + T6-B3 §16 — the state flip, the mandatory commercial-window
    // reconciliation, and every domain event commit atomically or not at all: an
    // assignment cannot end leaving a future commercial version selectable, nor
    // reconcile without ending, nor emit without both.
    await this.prisma.$transaction(async (tx) => {
      // T6-B2 §12.1 / T6-B3 §19 — take the SAME per-assignment row lock the
      // revision + cancellation transactions take, FIRST, so END serializes against
      // revision, explicit cancellation, and a concurrent END (the sole primitive).
      await tx.$executeRawUnsafe(
        `SELECT "id" FROM "placement"."ContractAssignment"
          WHERE "tenant_id" = $1::uuid AND "placement_process_id" = $2::uuid
          FOR UPDATE`,
        input.tenant_id,
        input.placement_process_id,
      );
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

      // §15 — derive ONE instant T_end from the DATABASE clock (L7-C: transaction-stable
      // now(), the SAME clock the B3 re-open trigger gates on), reused for
      // ContractAssignment.ended_at, commercial-window reconciliation, and the
      // assignment-ended event occurrence. No independent/app clocks.
      const tEnd = await this.commercialTxInstant(tx);

      // §16 — the non-cancelled commercial sequence at END, ascending. Reconciliation
      // guarantees NO non-cancelled version remains effective beyond T_end.
      const versions = await tx.assignmentRateVersion.findMany({
        where: { tenant_id: input.tenant_id, contract_assignment_id: existing.id, cancelled_at: null },
        orderBy: { effective_from: 'asc' },
      });

      // §18 — an END transaction may need cancellation, future-boundary re-open, AND
      // final first-close, so it sets BOTH governed markers (never one broad marker).
      await tx.$executeRawUnsafe(`SET LOCAL app.assignment_commercial_cancellation = 'authorized'`);
      await tx.$executeRawUnsafe(`SET LOCAL app.assignment_commercial_revision = 'authorized'`);

      // §16.5 — cancel every version starting at or after T_end (ASSIGNMENT_ENDED),
      // emitting one rate_version.cancelled event each. These future/boundary-start
      // windows can never become effective commercial truth for an ended assignment.
      for (const v of versions) {
        if (v.effective_from.getTime() >= tEnd.getTime()) {
          await tx.assignmentRateVersion.update({
            where: { id: v.id },
            data: {
              cancelled_at: tEnd,
              cancelled_by: input.ended_by,
              cancellation_reason_code: ASSIGNMENT_ENDED_CANCELLATION_REASON,
            },
          });
          await tx.outboxEvent.create({
            data: this.cancelledEventData({
              tenant_id: input.tenant_id,
              placement_process_id: input.placement_process_id,
              contract_assignment_id: existing.id,
              assignment_rate_version_id: v.id,
              original_effective_from: v.effective_from,
              cancelled_by: input.ended_by,
              cancellation_reason_code: ASSIGNMENT_ENDED_CANCELLATION_REASON,
              occurred_at: tEnd,
            }),
          });
        }
      }

      // §16.6/§16.7 — the version whose half-open interval CONTAINS T_end
      // (effective_from < T_end AND (effective_to IS NULL OR effective_to > T_end))
      // must end EXACTLY at T_end. A version already ending exactly at T_end, or one
      // whose start coincides with T_end (cancelled above), needs no boundary edit —
      // then there is no containing version and the sequence is already reconciled.
      const containing = versions.find(
        (v) =>
          v.effective_from.getTime() < tEnd.getTime() &&
          (v.effective_to === null || v.effective_to.getTime() > tEnd.getTime()),
      );
      if (containing !== undefined) {
        // A bounded future boundary is first RE-OPENED (its close was never-effective),
        // leaving a single open tail after the future-cancel pass, THEN first-closed at
        // T_end. An already-open tail is first-closed directly. Both land on [start,T_end).
        if (containing.effective_to !== null) {
          await tx.assignmentRateVersion.update({ where: { id: containing.id }, data: { effective_to: null } });
        }
        await tx.assignmentRateVersion.update({ where: { id: containing.id }, data: { effective_to: tEnd } });
      }

      await tx.contractAssignment.update({
        where: { id: existing.id },
        // The ratified ending reason is recorded structurally (COMPLETED /
        // WORKER_ENDED / CLIENT_ENDED), atomically with the state flip and the
        // durable T_end instant (§15).
        data: { lifecycle_state: 'ENDED', end_reason: input.end_reason, ended_at: tEnd },
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
            occurred_at: tEnd.toISOString(),
          },
        },
      });
    });
  }

  // Slice #3 (LOCKED Aramo-Assignment-Extension v1.0) — govern an ACTIVE assignment's
  // planned end strictly FORWARD, with NO lifecycle transition (R-EXTENSION-NOT-STATE).
  // One atomic tx (R-EXTEND-TXN): lock the assignment, validate forward-only, append the
  // immutable AssignmentExtension history row, update the current expected_end_at, and
  // emit placement.assignment.extended. Capacity-neutral (the assignment stays ACTIVE, so
  // the derived consuming-count is unchanged). Returns the fresh assignment view.
  async extendAssignment(
    input: {
      tenant_id: string;
      placement_process_id: string;
      new_expected_end_at: string; // ISO-8601 instant
      reason: AssignmentExtensionReason;
      comment?: string | null;
      actor_id: string;
      source?: AssignmentExtensionSource;
      external_reference?: string | null;
    },
    requestId: string,
  ): Promise<ContractAssignmentView> {
    const newEnd = new Date(input.new_expected_end_at);
    if (Number.isNaN(newEnd.getTime())) {
      throw new AramoError('VALIDATION_ERROR', 'new_expected_end_at is not a valid instant', 400, {
        requestId,
        details: { field: 'new_expected_end_at' },
      });
    }
    const source = input.source ?? 'MANUAL';
    return this.prisma.$transaction(async (tx) => {
      // Serialize against end / commercial revision / a concurrent extend on the SAME
      // assignment (the same per-assignment row lock the END primitive takes).
      await tx.$executeRawUnsafe(
        `SELECT "id" FROM "placement"."ContractAssignment"
          WHERE "tenant_id" = $1::uuid AND "placement_process_id" = $2::uuid
          FOR UPDATE`,
        input.tenant_id,
        input.placement_process_id,
      );
      const existing = (await tx.contractAssignment.findFirst({
        where: {
          tenant_id: input.tenant_id,
          placement_process_id: input.placement_process_id,
          lifecycle_state: 'ACTIVE',
        },
        select: {
          id: true,
          submittal_id: true,
          requisition_id: true,
          talent_record_id: true,
          started_at: true,
          provenance: true,
          expected_end_at: true,
        },
      })) as {
        id: string;
        submittal_id: string;
        requisition_id: string;
        talent_record_id: string;
        started_at: Date;
        provenance: 'FORWARD' | 'BACKFILLED';
        expected_end_at: Date | null;
      } | null;
      if (existing === null) {
        // Only an ACTIVE assignment can be extended — never ENDED (no lifecycle bloat).
        throw new AramoError('NOT_FOUND', 'No active ContractAssignment to extend', 404, {
          requestId,
          details: { placement_process_id: input.placement_process_id, reason: 'active_assignment_not_found' },
        });
      }
      // Forward-only (R-EXTEND-TXN): the new horizon must be in the future AND strictly
      // beyond the current one (or beyond the actual start when none is set yet). A
      // backward / equal / past target is a refusal, not an extension.
      const tExtend = new Date();
      const floor = existing.expected_end_at ?? existing.started_at;
      if (newEnd.getTime() <= tExtend.getTime()) {
        throw new AramoError('ASSIGNMENT_EXTENSION_NOT_FORWARD', 'new_expected_end_at must be in the future', 422, {
          requestId,
          details: { placement_process_id: input.placement_process_id, reason: 'not_future' },
        });
      }
      if (newEnd.getTime() <= floor.getTime()) {
        throw new AramoError('ASSIGNMENT_EXTENSION_NOT_FORWARD', 'new_expected_end_at must be strictly after the current expected end', 422, {
          requestId,
          details: { placement_process_id: input.placement_process_id, reason: 'not_forward' },
        });
      }
      await tx.assignmentExtension.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          assignment_id: existing.id,
          previous_expected_end_at: existing.expected_end_at,
          new_expected_end_at: newEnd,
          reason: input.reason,
          comment: input.comment ?? null,
          actor_id: input.actor_id,
          source,
          external_reference: input.external_reference ?? null,
          occurred_at: tExtend,
        },
      });
      await tx.contractAssignment.update({
        where: { id: existing.id },
        data: { expected_end_at: newEnd },
      });
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: OUTBOX_ASSIGNMENT_EXTENDED,
          event_payload: {
            assignment_id: existing.id,
            placement_process_id: input.placement_process_id,
            tenant_id: input.tenant_id,
            submittal_id: existing.submittal_id,
            requisition_id: existing.requisition_id,
            talent_record_id: existing.talent_record_id,
            previous_expected_end_at: existing.expected_end_at?.toISOString() ?? null,
            new_expected_end_at: newEnd.toISOString(),
            reason: input.reason,
            source,
            occurred_at: tExtend.toISOString(),
          },
        },
      });
      // The fresh view — ending_soon re-derived from the new horizon.
      return {
        id: existing.id,
        placement_process_id: input.placement_process_id,
        submittal_id: existing.submittal_id,
        requisition_id: existing.requisition_id,
        talent_record_id: existing.talent_record_id,
        started_at: existing.started_at,
        provenance: existing.provenance,
        lifecycle_state: 'ACTIVE',
        end_reason: null,
        expected_end_at: newEnd,
        ending_soon: isAssignmentEndingSoon({ lifecycle_state: 'ACTIVE', expected_end_at: newEnd }),
      };
    });
  }

  // Track 7 / T7-PX — Contract-to-Permanent conversion. ONE atomic placement-domain
  // transaction that ENDS the ACTIVE ContractAssignment (CONVERTED_TO_PERMANENT) and
  // materialises a NEW PERMANENT PlacementProcess + its GUARANTEE_ACTIVE PermanentPlacement
  // (§1/§2). The originating STARTED contract placement is NEVER reused or mutated (it stays
  // historical + frozen); the new placement is the permanent lineage anchor. Capacity holds
  // exactly 1 consumer across the commit (−1 contract ACTIVE, +1 permanent GUARANTEE_ACTIVE
  // in the same tx → no committed 0/2 seat state, §7). Guarantee terms come ONLY from the
  // governed stored version effective at guarantee_start_date (§6); no caller money/policy.
  // Idempotent: a prior conversion of this source placement REPLAYS the same target (§11).
  async convertToPermanent(
    input: { tenant_id: string; placement_process_id: string; converted_by: string },
    requestId: string,
  ): Promise<ConvertToPermanentResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // §11 — take the SAME per-assignment row lock END/revision/cancellation take,
        // FIRST, so CONVERT serialises against END and a concurrent CONVERT (the sole
        // primitive). Two concurrent conversions of this placement serialise here; the
        // second, after the first commits, replays via the lineage check below.
        await tx.$executeRawUnsafe(
          `SELECT "id" FROM "placement"."ContractAssignment"
            WHERE "tenant_id" = $1::uuid AND "placement_process_id" = $2::uuid
            FOR UPDATE`,
          input.tenant_id,
          input.placement_process_id,
        );

        // §11 — deterministic replay: a source placement already converted returns its
        // existing target rather than minting a second permanent placement.
        const priorLineage = (await tx.permanentPlacementConversionLineage.findFirst({
          where: { tenant_id: input.tenant_id, source_placement_process_id: input.placement_process_id },
        })) as ConversionLineageRow | null;
        if (priorLineage !== null) {
          return conversionResult(priorLineage, true);
        }

        // Eligibility: a STARTED source placement with an ACTIVE ContractAssignment.
        const source = (await tx.placementProcess.findFirst({
          where: { tenant_id: input.tenant_id, id: input.placement_process_id },
        })) as PlacementProcessRow | null;
        if (source === null) {
          throw new AramoError('NOT_FOUND', 'PlacementProcess not found', 404, {
            requestId,
            details: { placement_process_id: input.placement_process_id, reason: 'placement_process_not_found' },
          });
        }
        if (source.state !== 'STARTED') {
          throw new AramoError('PLACEMENT_STATE_INVALID', 'only a STARTED contract placement can be converted to permanent', 422, {
            requestId,
            details: { placement_process_id: input.placement_process_id, state: source.state, reason: 'source_not_started' },
          });
        }
        const assignment = (await tx.contractAssignment.findFirst({
          where: { tenant_id: input.tenant_id, placement_process_id: input.placement_process_id, lifecycle_state: 'ACTIVE' },
          select: { id: true, submittal_id: true, requisition_id: true, talent_record_id: true },
        })) as { id: string; submittal_id: string; requisition_id: string; talent_record_id: string } | null;
        if (assignment === null) {
          throw new AramoError('NOT_FOUND', 'No active ContractAssignment to convert', 404, {
            requestId,
            details: { placement_process_id: input.placement_process_id, reason: 'active_assignment_not_found' },
          });
        }

        // §5 — ONE absolute instant from the DATABASE clock (L7-C: transaction-stable
        // now(), matching the B3 re-open trigger). guarantee_start_date is its UTC
        // CALENDAR date (no browser/tenant-local timezone, no caller-supplied tz).
        const tConvert = await this.commercialTxInstant(tx);
        const guaranteeStartStr = tConvert.toISOString().slice(0, 10);
        const guaranteeStart = parseCalendarDate(guaranteeStartStr);
        if (guaranteeStart === null) {
          throw new AramoError('PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID', 'derived guarantee_start_date is not a valid calendar date', 422, {
            requestId,
            details: { reason: 'start_date_invalid', guarantee_start_date: guaranteeStartStr },
          });
        }

        // §6 — governed guarantee terms come ONLY from the stored version effective at
        // guarantee_start_date; NO caller exposure/policy/duration/currency. Fail closed
        // when none is effective; >1 effective is PERMANENT_PLACEMENT_TERMS_AMBIGUOUS (500).
        const storedRow = await resolveEffectiveTermRow(
          tx as unknown as PrismaService,
          input.tenant_id,
          source.requisition_id,
          guaranteeStart,
          requestId,
        );
        if (storedRow === null) {
          throw new AramoError('PERMANENT_PLACEMENT_TERMS_NOT_FOUND', 'no guarantee-term version is effective for the requisition at the conversion date', 404, {
            requestId,
            details: { requisition_id: source.requisition_id, reason: 'no_stored_terms_for_conversion' },
          });
        }
        const resolved = resolvedTermsFromRow(storedRow);
        const guaranteeEnd = addUtcDaysLocal(guaranteeStart, resolved.guarantee_duration_days);

        // §8 — close the contract commercial window at T_convert, reusing the T6 END
        // reconciliation logic: set BOTH governed markers, cancel every version starting
        // at/after T_convert (emitting one rate_version.cancelled each), then first-close
        // the containing version at T_convert. History is PRESERVED (closed, never
        // deleted/rewritten); the append-only DELETE-reject trigger forbids destruction.
        const versions = await tx.assignmentRateVersion.findMany({
          where: { tenant_id: input.tenant_id, contract_assignment_id: assignment.id, cancelled_at: null },
          orderBy: { effective_from: 'asc' },
        });
        await tx.$executeRawUnsafe(`SET LOCAL app.assignment_commercial_cancellation = 'authorized'`);
        await tx.$executeRawUnsafe(`SET LOCAL app.assignment_commercial_revision = 'authorized'`);
        for (const v of versions) {
          if (v.effective_from.getTime() >= tConvert.getTime()) {
            await tx.assignmentRateVersion.update({
              where: { id: v.id },
              data: { cancelled_at: tConvert, cancelled_by: input.converted_by, cancellation_reason_code: ASSIGNMENT_ENDED_CANCELLATION_REASON },
            });
            await tx.outboxEvent.create({
              data: this.cancelledEventData({
                tenant_id: input.tenant_id,
                placement_process_id: input.placement_process_id,
                contract_assignment_id: assignment.id,
                assignment_rate_version_id: v.id,
                original_effective_from: v.effective_from,
                cancelled_by: input.converted_by,
                cancellation_reason_code: ASSIGNMENT_ENDED_CANCELLATION_REASON,
                occurred_at: tConvert,
              }),
            });
          }
        }
        const containing = versions.find(
          (v) => v.effective_from.getTime() < tConvert.getTime() && (v.effective_to === null || v.effective_to.getTime() > tConvert.getTime()),
        );
        if (containing !== undefined) {
          if (containing.effective_to !== null) {
            await tx.assignmentRateVersion.update({ where: { id: containing.id }, data: { effective_to: null } });
          }
          await tx.assignmentRateVersion.update({ where: { id: containing.id }, data: { effective_to: tConvert } });
        }

        // §2 — END the source ContractAssignment with the CONVERTED_TO_PERMANENT reason
        // (a genuine domain value, NOT attrition — §3/§13), atomically with the durable
        // T_convert instant, then emit the assignment.ended event (reuse).
        await tx.contractAssignment.update({
          where: { id: assignment.id },
          data: { lifecycle_state: 'ENDED', end_reason: 'CONVERTED_TO_PERMANENT', ended_at: tConvert },
        });
        await tx.outboxEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            event_type: OUTBOX_ASSIGNMENT_ENDED,
            event_payload: {
              assignment_id: assignment.id,
              placement_process_id: input.placement_process_id,
              tenant_id: input.tenant_id,
              submittal_id: assignment.submittal_id,
              requisition_id: assignment.requisition_id,
              talent_record_id: assignment.talent_record_id,
              end_reason: 'CONVERTED_TO_PERMANENT',
              occurred_at: tConvert.toISOString(),
            },
          },
        });

        // §1/§2 — mint the NEW PERMANENT PlacementProcess directly in STARTED (the
        // lifecycle trigger is UPDATE-only; INSERT is governed by the assignment-aware
        // one-live guard, which RELEASES the old STARTED-with-ENDED-assignment placement
        // — ENDED above in this tx — so this insert passes). Same submittal/requisition/
        // talent (the same engagement). NOT E4 replaces_* (§4).
        const targetPlacementId = uuidv7();
        await tx.placementProcess.create({
          data: {
            id: targetPlacementId,
            tenant_id: input.tenant_id,
            submittal_id: assignment.submittal_id,
            requisition_id: assignment.requisition_id,
            talent_record_id: assignment.talent_record_id,
            state: 'STARTED',
            offered_at: tConvert,
            placement_kind: 'PERMANENT',
          },
        });
        await tx.placementProcessEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            placement_process_id: targetPlacementId,
            event_type: 'state_transition',
            event_payload: { from: null, to: 'STARTED' },
          },
        });

        // §2 — the PermanentPlacement in GUARANTEE_ACTIVE, carrying the immutable governed
        // snapshot copied from the stored term version at activation.
        const permanentId = uuidv7();
        await tx.permanentPlacement.create({
          data: {
            id: permanentId,
            tenant_id: input.tenant_id,
            placement_process_id: targetPlacementId,
            submittal_id: assignment.submittal_id,
            requisition_id: assignment.requisition_id,
            talent_record_id: assignment.talent_record_id,
            lifecycle_state: 'GUARANTEE_ACTIVE',
            guarantee_start_date: guaranteeStart,
            guarantee_duration_days: resolved.guarantee_duration_days,
            guarantee_end_date: guaranteeEnd,
            remedy_policy: resolved.remedy_policy,
            guarantee_exposure_amount: resolved.guarantee_exposure_amount,
            guarantee_exposure_currency: resolved.currency,
            terms_source: resolved.source_type,
            recorded_by: input.converted_by,
            guarantee_term_version_id: resolved.guarantee_term_version_id,
            guarantee_terms_source_type: resolved.source_type,
            guarantee_terms_source_reference: resolved.source_reference,
            guarantee_terms_source_version: resolved.source_version,
          },
        });
        await tx.permanentPlacementEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            permanent_placement_id: permanentId,
            event_type: 'state_transition',
            event_payload: { from: null, to: 'GUARANTEE_ACTIVE' },
          },
        });

        // §4 — the immutable conversion lineage (idempotency anchor). Its unique keys are
        // the DB race floor: a concurrent duplicate collides here and replays (see catch).
        await tx.permanentPlacementConversionLineage.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            source_placement_process_id: input.placement_process_id,
            source_contract_assignment_id: assignment.id,
            target_placement_process_id: targetPlacementId,
            target_permanent_placement_id: permanentId,
            converted_at: tConvert,
            converted_by: input.converted_by,
          },
        });

        // §12 — governed events (identity/lineage facts ONLY; NO PII, NO money): the
        // permanent creation + guarantee activation (reuse), the optional terms-applied
        // event, and the dedicated conversion event.
        const permanentPayload = {
          tenant_id: input.tenant_id,
          permanent_placement_id: permanentId,
          placement_process_id: targetPlacementId,
          submittal_id: assignment.submittal_id,
          requisition_id: assignment.requisition_id,
          talent_record_id: assignment.talent_record_id,
          lifecycle_state: 'GUARANTEE_ACTIVE',
          guarantee_start_date: guaranteeStart.toISOString().slice(0, 10),
          guarantee_end_date: guaranteeEnd.toISOString().slice(0, 10),
          remedy_policy: resolved.remedy_policy,
          occurred_at: tConvert.toISOString(),
        };
        await tx.outboxEvent.create({ data: { id: uuidv7(), tenant_id: input.tenant_id, event_type: OUTBOX_PERMANENT_PLACEMENT_CREATED, event_payload: permanentPayload } });
        await tx.outboxEvent.create({ data: { id: uuidv7(), tenant_id: input.tenant_id, event_type: OUTBOX_PERMANENT_PLACEMENT_GUARANTEE_ACTIVE, event_payload: permanentPayload } });
        if (resolved.guarantee_term_version_id !== null) {
          await tx.outboxEvent.create({
            data: {
              id: uuidv7(),
              tenant_id: input.tenant_id,
              event_type: OUTBOX_GUARANTEE_TERMS_APPLIED,
              event_payload: {
                tenant_id: input.tenant_id,
                requisition_id: source.requisition_id,
                permanent_placement_id: permanentId,
                guarantee_term_version_id: resolved.guarantee_term_version_id,
                source_type: resolved.source_type,
                occurred_at: tConvert.toISOString(),
              },
            },
          });
        }
        await tx.outboxEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            event_type: OUTBOX_ASSIGNMENT_CONVERTED_TO_PERMANENT,
            event_payload: {
              tenant_id: input.tenant_id,
              source_placement_process_id: input.placement_process_id,
              source_contract_assignment_id: assignment.id,
              target_placement_process_id: targetPlacementId,
              target_permanent_placement_id: permanentId,
              requisition_id: source.requisition_id,
              submittal_id: assignment.submittal_id,
              talent_record_id: assignment.talent_record_id,
              occurred_at: tConvert.toISOString(),
            },
          },
        });

        return {
          replayed: false,
          source_placement_process_id: input.placement_process_id,
          source_contract_assignment_id: assignment.id,
          target_placement_process_id: targetPlacementId,
          target_permanent_placement_id: permanentId,
        };
      });
    } catch (err) {
      // §11 race floor: two conversions that both passed the lock check (a rare window)
      // collide on the lineage unique key. Re-read the committed winner and replay.
      if (isConversionLineageDuplicate(err)) {
        const won = (await this.prisma.permanentPlacementConversionLineage.findFirst({
          where: { tenant_id: input.tenant_id, source_placement_process_id: input.placement_process_id },
        })) as ConversionLineageRow | null;
        if (won !== null) return conversionResult(won, true);
      }
      throw err;
    }
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
    const row = await this.prisma.contractAssignment.findFirst({
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
        expected_end_at: true,
      },
    });
    if (row === null) return null;
    // Slice #3 (R-ENDING-SOON) — DERIVE ending_soon on read; never stored.
    return {
      ...(row as Omit<ContractAssignmentView, 'ending_soon'>),
      ending_soon: isAssignmentEndingSoon({
        lifecycle_state: row.lifecycle_state,
        expected_end_at: row.expected_end_at,
      }),
    };
  }

  // Track 6 / T6-B1 — the canonical point-in-time commercial projection of the
  // assignment on a placement. Reads the tenant-scoped ContractAssignment to resolve
  // the assignment id + lineage, then the AS-OF effective AssignmentRateVersion
  // (cancelled_at IS NULL AND effective_from <= asOf AND (effective_to IS NULL OR
  // effective_to > asOf)), and derives spread/margin/markup ON READ
  // (deriveCommercialMetrics — never stored). asOf defaults to the current instant so
  // every existing caller keeps its "now" behaviour; historical (asOf < now) and
  // future-preview (asOf > now) resolution are expressed by an explicit asOf and are
  // internal-only in B1 (no new route/param). Returns null on coherent absence: no
  // assignment, or no selectable version. Cancelled versions are ignored. Visibility
  // is enforced by the caller loading the placement through findByIdForActor FIRST
  // (house pattern) — placement_process_id stays the public anchor and the assignment
  // UUID is never a public visibility boundary. NOTE: from T6-B1 a btree_gist EXCLUDE
  // prevents overlapping non-cancelled windows at the DB, so sanctioned writes can no
  // longer create ambiguity; the AT-MOST-TWO fetch + fail-closed check below is
  // retained as legacy/corruption defence, never a winner-picker.
  async findAssignmentCommercialProjection(
    tenant_id: string,
    placement_process_id: string,
    requestId: string,
    asOf: Date = new Date(),
  ): Promise<AssignmentCommercialView | null> {
    const assignment = await this.prisma.contractAssignment.findFirst({
      where: { tenant_id, placement_process_id },
      select: { id: true, requisition_id: true, talent_record_id: true },
    });
    if (assignment === null) return null;

    // Fetch AT MOST TWO effective versions so a legacy/corrupt overlap is DETECTED,
    // not silently collapsed to a latest-wins winner. Cancelled versions never
    // participate in resolution (they also drop out of the DB overlap constraint).
    const active = await this.prisma.assignmentRateVersion.findMany({
      where: {
        tenant_id,
        contract_assignment_id: assignment.id,
        cancelled_at: null,
        effective_from: { lte: asOf },
        OR: [{ effective_to: null }, { effective_to: { gt: asOf } }],
      },
      orderBy: { effective_from: 'desc' },
      take: 2,
    });
    const [version, ...rest] = active;
    if (version === undefined) return null;
    if (rest.length > 0) {
      // >1 effective version = corrupt/ambiguous commercial state. FAIL CLOSED — a
      // server-integrity error (INTERNAL_ERROR / 500, the registry convention), never
      // a silently-chosen winner. NO mutation, NO effective_to repair, NO supersession;
      // NO competing financial values in the payload (only the anchor + a count).
      throw new AramoError(
        'INTERNAL_ERROR',
        'ambiguous commercial version state: more than one effective AssignmentRateVersion',
        500,
        {
          requestId,
          details: {
            contract_assignment_id: assignment.id,
            reason: 'commercial_version_ambiguity',
            active_count: active.length,
          },
        },
      );
    }

    const metrics = deriveCommercialMetrics(version.pay_rate_amount, version.bill_rate_amount);
    return {
      contract_assignment_id: assignment.id,
      assignment_rate_version_id: version.id,
      requisition_id: assignment.requisition_id,
      talent_record_id: assignment.talent_record_id,
      pay_rate_amount: version.pay_rate_amount.toFixed(2),
      bill_rate_amount: version.bill_rate_amount.toFixed(2),
      currency: version.currency,
      rate_period: version.rate_period,
      spread_amount: metrics.spread_amount,
      margin_percent: metrics.margin_percent,
      markup_percent: metrics.markup_percent,
      effective_from: version.effective_from,
      effective_to: version.effective_to,
      change_reason: version.change_reason,
      recorded_by: version.recorded_by,
      created_at: version.created_at,
    };
  }

  // Track 6 / T6-B2 — the first governed POST-START commercial revision. Open-tail
  // ONLY (§3): close the single non-cancelled OPEN predecessor at T_new, then append
  // the successor at [T_new, ∞). ACTIVE-only, atomic, and serialized against
  // endAssignment by a FOR UPDATE lock on the owning ContractAssignment. The clock is
  // read ONCE — the same T_new bounds the predecessor close and the successor open.
  async createCommercialRevision(
    input: {
      tenant_id: string;
      placement_process_id: string;
      pay_rate_amount: string;
      bill_rate_amount: string;
      currency: string;
      rate_period: string;
      effective_from?: string | null;
      change_reason: string;
      recorded_by: string;
    },
    requestId: string,
  ): Promise<AssignmentCommercialView> {
    // Pre-transaction, ZERO-mutation validation (mirrors the STARTED write boundary).
    if (!isIso4217Currency(input.currency)) {
      throw new AramoError('VALIDATION_ERROR', 'currency must be a valid ISO-4217 code', 400, { requestId, details: { field: 'currency' } });
    }
    if (!isRatePeriod(input.rate_period)) {
      throw new AramoError('VALIDATION_ERROR', 'rate_period must be a supported value', 400, { requestId, details: { field: 'rate_period' } });
    }
    if (!MONEY_12_2.test(input.pay_rate_amount) || !MONEY_12_2.test(input.bill_rate_amount)) {
      throw new AramoError('VALIDATION_ERROR', 'pay/bill must be a non-negative Decimal(12,2) money string', 400, { requestId, details: { field: 'amount' } });
    }
    const changeReason = input.change_reason.trim();
    if (changeReason.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'change_reason is required', 400, { requestId, details: { field: 'change_reason' } });
    }
    // L7-B — a direct commercial revision REQUIRES an explicit effective_from: the
    // revision's identity IS its effective instant, so the (tenant, assignment,
    // effective_from) unique key makes a harmless retry collide (409 duplicate_effective_from)
    // instead of silently minting a second version because the server clock advanced.
    // (The governed APPLY path resolves its own instant from the proposal and is idempotent
    // via the one-live proposal + the atomic APPLY lock — it does not pass through here.)
    if (input.effective_from == null) {
      throw new AramoError('VALIDATION_ERROR', 'effective_from is required for a commercial revision (deterministic revision identity)', 400, { requestId, details: { field: 'effective_from', reason: 'effective_from_required' } });
    }
    const now = new Date();
    const parsed = new Date(input.effective_from);
    if (Number.isNaN(parsed.getTime())) {
      throw new AramoError('VALIDATION_ERROR', 'effective_from must be a valid ISO-8601 instant', 400, { requestId, details: { field: 'effective_from' } });
    }
    // No backdating (§6.1): a supplied instant materially in the past is refused.
    if (parsed.getTime() < now.getTime()) {
      throw new AramoError('VALIDATION_ERROR', 'effective_from cannot be in the past', 400, { requestId, details: { field: 'effective_from', reason: 'effective_from_in_past' } });
    }
    const tNew = parsed;

    return this.prisma.$transaction((tx) =>
      this.appendCommercialRevisionInTx(
        tx,
        {
          tenant_id: input.tenant_id,
          placement_process_id: input.placement_process_id,
          pay_rate_amount: input.pay_rate_amount,
          bill_rate_amount: input.bill_rate_amount,
          currency: input.currency,
          rate_period: input.rate_period,
          changeReason,
          recorded_by: input.recorded_by,
        },
        tNew,
        requestId,
      ),
    );
  }

  // L7-A — the in-transaction ARV first-close+append CORE, extracted so BOTH
  // createCommercialRevision (its own tx) AND the governed proposal APPLY (INSIDE the
  // decide tx) execute it. That is what gives APPLY single-transaction atomicity: the
  // rate-version append and the proposal APPLIED stamp commit together or not at all,
  // so a concurrent double-APPLY can no longer leave an orphan AssignmentRateVersion.
  // Assumes the caller already ran the pre-tx validation (currency/rate_period/money/
  // change_reason) and resolved `tNew`; this helper locks the owning assignment FIRST
  // (same row lock endAssignment/convert take → revision-vs-revision AND revision-vs-end
  // serialize), first-closes the open predecessor, appends the successor + its atomic
  // money-free outbox event, and returns the projected view.
  private async appendCommercialRevisionInTx(
    tx: Prisma.TransactionClient,
    input: {
      tenant_id: string;
      placement_process_id: string;
      pay_rate_amount: string;
      bill_rate_amount: string;
      currency: string;
      rate_period: string;
      changeReason: string;
      recorded_by: string;
    },
    tNew: Date,
    requestId: string,
  ): Promise<AssignmentCommercialView> {
    // §12.1 — lock the owning assignment row FIRST. endAssignment takes the SAME
    // lock, serializing revision-vs-revision AND revision-vs-end (no shared column
    // otherwise couples them).
    const locked = await tx.$queryRawUnsafe<
      Array<{ id: string; requisition_id: string; talent_record_id: string; lifecycle_state: string | null }>
    >(
      `SELECT "id", "requisition_id", "talent_record_id", "lifecycle_state"::text AS "lifecycle_state"
         FROM "placement"."ContractAssignment"
        WHERE "tenant_id" = $1::uuid AND "placement_process_id" = $2::uuid
        FOR UPDATE`,
      input.tenant_id,
      input.placement_process_id,
    );
    const assignment = locked[0];
    if (assignment === undefined) {
      throw new AramoError('NOT_FOUND', 'No ContractAssignment for placement', 404, { requestId, details: { placement_process_id: input.placement_process_id, reason: 'assignment_not_found' } });
    }
    if (assignment.lifecycle_state !== 'ACTIVE') {
      throw new AramoError('NOT_FOUND', 'No active ContractAssignment to revise', 404, { requestId, details: { placement_process_id: input.placement_process_id, reason: 'active_assignment_not_found' } });
    }
    // The open tail = the single non-cancelled version with NULL effective_to (B1's
    // overlap EXCLUDE guarantees at most one). No open version → nothing to revise
    // (a BACKFILLED assignment lacking initial terms lands here — §4).
    const predecessor = await tx.assignmentRateVersion.findFirst({
      where: { tenant_id: input.tenant_id, contract_assignment_id: assignment.id, cancelled_at: null, effective_to: null },
    });
    if (predecessor === null) {
      throw new AramoError('NOT_FOUND', 'No open commercial version to revise', 404, { requestId, details: { placement_process_id: input.placement_process_id, reason: 'open_commercial_version_not_found' } });
    }
    if (tNew.getTime() <= predecessor.effective_from.getTime()) {
      throw new AramoError('VALIDATION_ERROR', 'effective_from must be after the current version start', 400, { requestId, details: { field: 'effective_from', reason: 'effective_from_not_after_current' } });
    }

    const successorId = uuidv7();
    try {
      // §11 — the governed effective_to first-close (B1 capability) under the
      // transaction-local marker, confined to this method; then append the
      // successor and its atomic outbox event.
      await tx.$executeRawUnsafe(`SET LOCAL app.assignment_commercial_revision = 'authorized'`);
      await tx.assignmentRateVersion.update({ where: { id: predecessor.id }, data: { effective_to: tNew } });
      const successor = await tx.assignmentRateVersion.create({
        data: {
          id: successorId,
          tenant_id: input.tenant_id,
          contract_assignment_id: assignment.id,
          requisition_id: assignment.requisition_id,
          talent_record_id: assignment.talent_record_id,
          pay_rate_amount: input.pay_rate_amount,
          bill_rate_amount: input.bill_rate_amount,
          currency: input.currency,
          rate_period: input.rate_period,
          effective_from: tNew,
          recorded_by: input.recorded_by,
          change_reason: input.changeReason,
        },
      });
      // Atomic outbox: identity/provenance ONLY (money EXCLUDED, A2 §8) + the
      // superseded predecessor id so a consumer can walk the revision chain.
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: OUTBOX_RATE_VERSION_CREATED,
          event_payload: {
            tenant_id: input.tenant_id,
            contract_assignment_id: assignment.id,
            assignment_rate_version_id: successorId,
            superseded_rate_version_id: predecessor.id,
            requisition_id: assignment.requisition_id,
            talent_record_id: assignment.talent_record_id,
            effective_from: tNew.toISOString(),
          },
        },
      });
      const metrics = deriveCommercialMetrics(successor.pay_rate_amount, successor.bill_rate_amount);
      return {
        contract_assignment_id: assignment.id,
        assignment_rate_version_id: successor.id,
        requisition_id: assignment.requisition_id,
        talent_record_id: assignment.talent_record_id,
        pay_rate_amount: successor.pay_rate_amount.toFixed(2),
        bill_rate_amount: successor.bill_rate_amount.toFixed(2),
        currency: successor.currency,
        rate_period: successor.rate_period,
        spread_amount: metrics.spread_amount,
        margin_percent: metrics.margin_percent,
        markup_percent: metrics.markup_percent,
        effective_from: successor.effective_from,
        effective_to: successor.effective_to,
        change_reason: successor.change_reason,
        recorded_by: successor.recorded_by,
        created_at: successor.created_at,
      };
    } catch (err) {
      // §16 — named-constraint translation; NEVER a raw P2002/23505/23P01 leak.
      // A cancelled row still reserves its exact effective_from (non-partial unique
      // key), so a same-instant re-schedule after cancellation stays this 409
      // duplicate_effective_from (T6-B3 §5).
      if (isWindowOverlapViolation(err)) {
        throw this.commercialConflict('window_overlap', assignment.id, requestId);
      }
      if (isDuplicateEffectiveFromViolation(err)) {
        throw this.commercialConflict('duplicate_effective_from', assignment.id, requestId);
      }
      throw err;
    }
  }

  // ==========================================================================
  // Requisition Workflow slice #4 — Commercial Approval (LOCKED
  // Aramo-Commercial-Approval-Directive-v1_0). The CommercialRevisionProposal
  // governance layer IN FRONT OF createCommercialRevision. THE GOVERNING
  // INVARIANT: proposal = INTENT, approval = AUTHORITY, AssignmentRateVersion =
  // APPLIED FINANCIAL TRUTH. Propose/submit/withdraw are proposer scope:write;
  // margin-approve/client-approve/apply/reject are commercials:approve authority
  // acts gated by SoD (actor != requested_by) + ADR-0024 (fail-closed). APPLY
  // reuses createCommercialRevision (R-APPLY) and, on its 409, leaves the proposal
  // APPROVED (R-APPLY-RECONCILIATION).
  // ==========================================================================

  // Propose (INTENT). Creates a DRAFT proposal for the assignment's next
  // commercial revision WITHOUT writing any AssignmentRateVersion. Requires an
  // ACTIVE assignment with an open predecessor version (the reference/current).
  async createCommercialRevisionProposal(
    input: {
      tenant_id: string;
      placement_process_id: string;
      pay_rate_amount: string;
      bill_rate_amount: string;
      currency: string;
      rate_period: string;
      effective_from?: string | null;
      reason: string;
      requested_by: string;
    },
    requestId: string,
  ): Promise<CommercialProposalView> {
    if (!isIso4217Currency(input.currency)) {
      throw new AramoError('VALIDATION_ERROR', 'currency must be a valid ISO-4217 code', 400, { requestId, details: { field: 'currency' } });
    }
    if (!isRatePeriod(input.rate_period)) {
      throw new AramoError('VALIDATION_ERROR', 'rate_period must be a supported value', 400, { requestId, details: { field: 'rate_period' } });
    }
    if (!MONEY_12_2.test(input.pay_rate_amount) || !MONEY_12_2.test(input.bill_rate_amount)) {
      throw new AramoError('VALIDATION_ERROR', 'pay/bill must be a non-negative Decimal(12,2) money string', 400, { requestId, details: { field: 'amount' } });
    }
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'reason is required', 400, { requestId, details: { field: 'reason' } });
    }
    let effectiveFrom: Date | null = null;
    if (input.effective_from != null) {
      const parsed = new Date(input.effective_from);
      if (Number.isNaN(parsed.getTime())) {
        throw new AramoError('VALIDATION_ERROR', 'effective_from must be a valid ISO-8601 instant', 400, { requestId, details: { field: 'effective_from' } });
      }
      // Strict not-past / not-before-current is re-checked at APPLY by
      // createCommercialRevision under lock — the proposal only captures intent.
      effectiveFrom = parsed;
    }

    // Resolve the ACTIVE assignment + its open reference version (no write yet).
    const assignment = await this.prisma.contractAssignment.findFirst({
      where: { tenant_id: input.tenant_id, placement_process_id: input.placement_process_id },
    });
    if (assignment === null) {
      throw new AramoError('NOT_FOUND', 'No ContractAssignment for placement', 404, { requestId, details: { placement_process_id: input.placement_process_id, reason: 'assignment_not_found' } });
    }
    if (assignment.lifecycle_state !== 'ACTIVE') {
      throw new AramoError('NOT_FOUND', 'No active ContractAssignment to propose against', 404, { requestId, details: { placement_process_id: input.placement_process_id, reason: 'active_assignment_not_found' } });
    }
    const reference = await this.prisma.assignmentRateVersion.findFirst({
      where: { tenant_id: input.tenant_id, contract_assignment_id: assignment.id, cancelled_at: null, effective_to: null },
    });
    if (reference === null) {
      throw new AramoError('NOT_FOUND', 'No open commercial version to revise', 404, { requestId, details: { placement_process_id: input.placement_process_id, reason: 'open_commercial_version_not_found' } });
    }

    const proposalId = uuidv7();
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.commercialRevisionProposal.create({
          data: {
            id: proposalId,
            tenant_id: input.tenant_id,
            contract_assignment_id: assignment.id,
            placement_process_id: input.placement_process_id,
            requisition_id: assignment.requisition_id,
            talent_record_id: assignment.talent_record_id,
            reference_rate_version_id: reference.id,
            proposed_pay_rate_amount: input.pay_rate_amount,
            proposed_bill_rate_amount: input.bill_rate_amount,
            proposed_currency: input.currency,
            proposed_rate_period: input.rate_period,
            proposed_effective_from: effectiveFrom,
            reason,
            state: COMMERCIAL_PROPOSAL_INITIAL_STATE,
            requested_by: input.requested_by,
          },
        });
        await tx.commercialRevisionProposalEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            proposal_id: proposalId,
            event_type: 'state_transition',
            event_payload: { previous_state: null, next_state: COMMERCIAL_PROPOSAL_INITIAL_STATE, action: 'PROPOSE', actor_id: input.requested_by },
          },
        });
        return created;
      });
      return this.toProposalView(row, reference);
    } catch (err) {
      if (isProposalOneLiveViolation(err)) {
        throw new AramoError('COMMERCIAL_PROPOSAL_ALREADY_LIVE', 'A live commercial proposal already exists for this assignment', 409, {
          requestId, details: { contract_assignment_id: assignment.id },
        });
      }
      throw err;
    }
  }

  // Proposer transitions (SUBMIT / WITHDRAW) — scope:write, NO policy, NO SoD.
  async transitionCommercialRevisionProposal(
    input: {
      tenant_id: string;
      placement_process_id: string;
      proposal_id: string;
      action: 'submit' | 'withdraw';
      actor_id: string;
    },
    requestId: string,
  ): Promise<CommercialProposalView> {
    const proposal = await this.loadProposal(input.tenant_id, input.placement_process_id, input.proposal_id, requestId);
    const to = input.action === 'submit' ? 'PENDING_REVIEW' : 'WITHDRAWN';
    const action = governingCommercialProposalAction(proposal.state as never, to);
    if (action === null || action !== (input.action === 'submit' ? 'SUBMIT' : 'WITHDRAW')) {
      throw this.proposalStateInvalid(proposal.state, to, requestId);
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.commercialRevisionProposal.update({ where: { id: proposal.id }, data: { state: to } });
      await tx.commercialRevisionProposalEvent.create({
        data: {
          id: uuidv7(), tenant_id: input.tenant_id, proposal_id: proposal.id,
          event_type: 'state_transition',
          event_payload: { previous_state: proposal.state, next_state: to, action, actor_id: input.actor_id },
        },
      });
      return updated;
    });
    return this.toProposalView(row);
  }

  // Authority transitions (MARGIN_APPROVE / CLIENT_APPROVE / APPLY / REJECT) —
  // commercials:approve + SoD (actor != requested_by) + ADR-0024 fail-closed.
  async decideCommercialRevisionProposal(
    input: {
      tenant_id: string;
      placement_process_id: string;
      proposal_id: string;
      action: 'margin_approve' | 'client_approve' | 'apply' | 'reject';
      actor_id: string;
      scopes: readonly string[];
      note?: string | null;
      client_reference?: string | null;
      client_approval_source?: string | null;
    },
    requestId: string,
  ): Promise<CommercialProposalView> {
    const proposal = await this.loadProposal(input.tenant_id, input.placement_process_id, input.proposal_id, requestId);
    const to =
      input.action === 'margin_approve' ? 'PENDING_CLIENT_APPROVAL'
      : input.action === 'client_approve' ? 'APPROVED'
      : input.action === 'apply' ? 'APPLIED'
      : 'REJECTED';
    const action = governingCommercialProposalAction(proposal.state as never, to);
    const expected: CommercialApprovalAction =
      input.action === 'margin_approve' ? 'MARGIN_APPROVE'
      : input.action === 'client_approve' ? 'CLIENT_APPROVE'
      : input.action === 'apply' ? 'APPLY'
      : 'REJECT';
    if (action === null || action !== expected || !isCommercialApprovalAuthorityAction(action)) {
      throw this.proposalStateInvalid(proposal.state, to, requestId);
    }

    // Segregation of duties (R-SOD) — fail-closed at the application boundary.
    if (input.actor_id === proposal.requested_by) {
      throw new AramoError('COMMERCIAL_PROPOSAL_SELF_APPROVAL', 'The proposer may not exercise commercial authority over their own proposal', 403, {
        requestId, details: { proposal_id: proposal.id, action: expected },
      });
    }

    // ADR-0024 fail-closed policy at the approval boundary (R-POLICY). Evaluate
    // BEFORE any write; a DENY persists the decision record and refuses.
    const policy = this.requireCommercialApprovalPolicy(requestId);
    const outcome = await policy.decide({
      tenant_id: input.tenant_id,
      action,
      from_state: proposal.state,
      scopes: input.scopes,
      actor_id: input.actor_id,
      origin: 'ui',
      correlation_id: requestId,
    });
    if (outcome.disposition === 'DENY') {
      await this.prisma.$transaction((tx) => insertPolicyDecisionRecordInTx(tx, outcome.provenance));
      throw new AramoError('POLICY_DENIED', 'The commercial approval policy denied this transition', 403, {
        requestId, details: { reason_code: outcome.reason_code },
      });
    }

    // APPLY (R-APPLY) — L7-A: ONE atomic governed transaction. Lock the proposal row
    // FIRST (deterministic order proposal → assignment), re-check its state UNDER the
    // lock, then append the AssignmentRateVersion and stamp APPLIED in the SAME tx via
    // appendCommercialRevisionInTx. A concurrent double-APPLY serializes on the proposal
    // lock: the loser re-reads state=APPLIED and returns the existing applied version —
    // so at most ONE rate version is ever created, with proposal.state + applied_rate_
    // version_id committed atomically (closes the orphan-rate-version race). On the
    // helper's ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT 409 the whole tx rolls back and
    // the proposal stays APPROVED (R-APPLY-RECONCILIATION).
    if (input.action === 'apply') {
      const row = await this.prisma.$transaction(async (tx) => {
        const lockedRows = await tx.$queryRawUnsafe<Array<{ state: string }>>(
          `SELECT "state"::text AS "state"
             FROM "placement"."CommercialRevisionProposal"
            WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid
            FOR UPDATE`,
          proposal.id,
          input.tenant_id,
        );
        const lockedState = lockedRows[0]?.state;
        // Idempotent replay: an already-APPLIED proposal returns its existing applied
        // rate version — NO second AssignmentRateVersion.
        if (lockedState === 'APPLIED') {
          return tx.commercialRevisionProposal.findUniqueOrThrow({ where: { id: proposal.id } });
        }
        // Re-check legality FROM the locked state (it may have moved since loadProposal).
        if (lockedState !== 'APPROVED') {
          throw this.proposalStateInvalid(lockedState ?? proposal.state, 'APPLIED', requestId);
        }
        // Resolve the effective instant at APPLY-time (proposed instant if any, else the
        // apply instant), re-checking no-backdating UNDER lock — a once-future proposal
        // may now be in the past. currency/rate_period/money were validated at propose.
        const appliedAt = new Date();
        let tNew = appliedAt;
        if (proposal.proposed_effective_from != null) {
          if (proposal.proposed_effective_from.getTime() < appliedAt.getTime()) {
            throw new AramoError('VALIDATION_ERROR', 'the proposed effective_from is now in the past; re-propose with a current instant', 400, {
              requestId,
              details: { field: 'effective_from', reason: 'effective_from_in_past' },
            });
          }
          tNew = proposal.proposed_effective_from;
        }
        const applied = await this.appendCommercialRevisionInTx(
          tx,
          {
            tenant_id: input.tenant_id,
            placement_process_id: proposal.placement_process_id,
            pay_rate_amount: proposal.proposed_pay_rate_amount.toFixed(2),
            bill_rate_amount: proposal.proposed_bill_rate_amount.toFixed(2),
            currency: proposal.proposed_currency,
            rate_period: proposal.proposed_rate_period,
            changeReason: proposal.reason,
            recorded_by: input.actor_id,
          },
          tNew,
          requestId,
        );
        const updated = await tx.commercialRevisionProposal.update({
          where: { id: proposal.id },
          data: { state: 'APPLIED', applied_rate_version_id: applied.assignment_rate_version_id, applied_by: input.actor_id, applied_at: appliedAt },
        });
        await tx.commercialRevisionProposalEvent.create({
          data: {
            id: uuidv7(), tenant_id: input.tenant_id, proposal_id: proposal.id,
            event_type: 'state_transition',
            event_payload: { previous_state: 'APPROVED', next_state: 'APPLIED', action, actor_id: input.actor_id, assignment_rate_version_id: applied.assignment_rate_version_id },
          },
        });
        await insertPolicyDecisionRecordInTx(tx, outcome.provenance);
        return updated;
      });
      return this.toProposalView(row);
    }

    // MARGIN_APPROVE / CLIENT_APPROVE / REJECT — record the transition + its
    // evidence + the policy decision atomically.
    const now = new Date();
    const data: Record<string, unknown> = { state: to };
    if (input.action === 'margin_approve') {
      data['review_decided_by'] = input.actor_id;
      data['review_decided_at'] = now;
      data['review_note'] = input.note ?? null;
    } else if (input.action === 'client_approve') {
      data['client_approved_at'] = now;
      data['client_approval_recorded_by'] = input.actor_id;
      data['client_reference'] = input.client_reference ?? null;
      data['client_approval_source'] = (input.client_approval_source ?? 'MANUAL');
      data['client_approval_note'] = input.note ?? null;
    } else {
      data['rejected_by'] = input.actor_id;
      data['rejected_at'] = now;
      data['rejection_reason'] = input.note ?? null;
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.commercialRevisionProposal.update({ where: { id: proposal.id }, data });
      await tx.commercialRevisionProposalEvent.create({
        data: {
          id: uuidv7(), tenant_id: input.tenant_id, proposal_id: proposal.id,
          event_type: 'state_transition',
          event_payload: { previous_state: proposal.state, next_state: to, action, actor_id: input.actor_id },
        },
      });
      await insertPolicyDecisionRecordInTx(tx, outcome.provenance);
      return updated;
    });
    return this.toProposalView(row);
  }

  // List all proposals for an assignment (newest first), each with the derived
  // margin comparison. commercials:read boundary.
  async findCommercialRevisionProposals(
    tenant_id: string,
    placement_process_id: string,
    requestId: string,
  ): Promise<CommercialProposalView[]> {
    const assignment = await this.prisma.contractAssignment.findFirst({
      where: { tenant_id, placement_process_id },
    });
    if (assignment === null) {
      throw new AramoError('NOT_FOUND', 'No ContractAssignment for placement', 404, { requestId, details: { placement_process_id, reason: 'assignment_not_found' } });
    }
    const rows = await this.prisma.commercialRevisionProposal.findMany({
      where: { tenant_id, contract_assignment_id: assignment.id },
      orderBy: { created_at: 'desc' },
    });
    return Promise.all(rows.map((r) => this.toProposalView(r)));
  }

  async findCommercialRevisionProposalById(
    tenant_id: string,
    placement_process_id: string,
    proposal_id: string,
    requestId: string,
  ): Promise<CommercialProposalView | null> {
    const row = await this.prisma.commercialRevisionProposal.findFirst({
      where: { tenant_id, placement_process_id, id: proposal_id },
    });
    if (row === null) return null;
    return this.toProposalView(row);
  }

  private requireCommercialApprovalPolicy(requestId: string): CommercialApprovalPolicyService {
    if (this.commercialApprovalPolicy === undefined) {
      // Fail-closed: an authority transition can never proceed without the gate.
      throw new AramoError('POLICY_DENIED', 'Commercial approval policy gate is not configured', 403, {
        requestId, details: { reason_code: 'POLICY_GATE_UNCONFIGURED' },
      });
    }
    return this.commercialApprovalPolicy;
  }

  private async loadProposal(
    tenant_id: string,
    placement_process_id: string,
    proposal_id: string,
    requestId: string,
  ) {
    const row = await this.prisma.commercialRevisionProposal.findFirst({
      where: { tenant_id, placement_process_id, id: proposal_id },
    });
    if (row === null) {
      throw new AramoError('NOT_FOUND', 'Commercial proposal not found in tenant', 404, { requestId, details: { proposal_id } });
    }
    return row;
  }

  private proposalStateInvalid(from: string, to: string, requestId: string): AramoError {
    return new AramoError('COMMERCIAL_PROPOSAL_STATE_INVALID', `Commercial proposal transition ${from} -> ${to} is not a legal edge`, 422, {
      requestId, details: { from, to },
    });
  }

  // Build the read projection. The `current` side derives from the reference
  // version captured at propose time (the terms the proposer was comparing
  // against); `proposed` from the stored intent; deltas are proposed minus
  // current, all Prisma.Decimal (never float).
  private async toProposalView(
    row: {
      id: string; contract_assignment_id: string; placement_process_id: string;
      requisition_id: string; talent_record_id: string; state: string;
      reference_rate_version_id: string;
      proposed_pay_rate_amount: Prisma.Decimal; proposed_bill_rate_amount: Prisma.Decimal;
      proposed_currency: string; proposed_rate_period: string;
      proposed_effective_from: Date | null; reason: string; requested_by: string;
      review_decided_by: string | null; review_decided_at: Date | null; review_note: string | null;
      client_approved_at: Date | null; client_approval_recorded_by: string | null;
      client_reference: string | null; client_approval_source: string | null; client_approval_note: string | null;
      rejected_by: string | null; rejected_at: Date | null; rejection_reason: string | null;
      applied_rate_version_id: string | null; applied_by: string | null; applied_at: Date | null;
      tenant_id: string; created_at: Date;
    },
    reference?: { pay_rate_amount: Prisma.Decimal; bill_rate_amount: Prisma.Decimal; currency: string; rate_period: string },
  ): Promise<CommercialProposalView> {
    const ref = reference ?? (await this.prisma.assignmentRateVersion.findFirst({
      where: { tenant_id: row.tenant_id, id: row.reference_rate_version_id },
      select: { pay_rate_amount: true, bill_rate_amount: true, currency: true, rate_period: true },
    })) ?? { pay_rate_amount: row.proposed_pay_rate_amount, bill_rate_amount: row.proposed_bill_rate_amount, currency: row.proposed_currency, rate_period: row.proposed_rate_period };

    const current = sideOf(ref.pay_rate_amount, ref.bill_rate_amount, ref.currency, ref.rate_period);
    const proposed = sideOf(row.proposed_pay_rate_amount, row.proposed_bill_rate_amount, row.proposed_currency, row.proposed_rate_period);
    const margin: CommercialMarginComparison = {
      current,
      proposed,
      pay_rate_delta: row.proposed_pay_rate_amount.minus(ref.pay_rate_amount).toFixed(2),
      bill_rate_delta: row.proposed_bill_rate_amount.minus(ref.bill_rate_amount).toFixed(2),
      margin_point_delta:
        proposed.margin_percent === null || current.margin_percent === null
          ? null
          : new Prisma.Decimal(proposed.margin_percent).minus(current.margin_percent).toFixed(2),
    };

    return {
      id: row.id,
      contract_assignment_id: row.contract_assignment_id,
      placement_process_id: row.placement_process_id,
      requisition_id: row.requisition_id,
      talent_record_id: row.talent_record_id,
      state: row.state,
      proposed_pay_rate_amount: row.proposed_pay_rate_amount.toFixed(2),
      proposed_bill_rate_amount: row.proposed_bill_rate_amount.toFixed(2),
      proposed_currency: row.proposed_currency,
      proposed_rate_period: row.proposed_rate_period,
      proposed_effective_from: row.proposed_effective_from,
      reason: row.reason,
      requested_by: row.requested_by,
      margin,
      review_decided_by: row.review_decided_by,
      review_decided_at: row.review_decided_at,
      review_note: row.review_note,
      client_approved_at: row.client_approved_at,
      client_approval_recorded_by: row.client_approval_recorded_by,
      client_reference: row.client_reference,
      client_approval_source: row.client_approval_source,
      client_approval_note: row.client_approval_note,
      rejected_by: row.rejected_by,
      rejected_at: row.rejected_at,
      rejection_reason: row.rejection_reason,
      applied_rate_version_id: row.applied_rate_version_id,
      applied_by: row.applied_by,
      applied_at: row.applied_at,
      created_at: row.created_at,
    };
  }

  // Track 6 / T6-B3 — explicit governed cancellation of a FUTURE open-tail
  // commercial revision (§3/§4). Eligible ONLY when the target is, simultaneously,
  // on an ACTIVE assignment, not already cancelled, starts strictly in the future,
  // and is the open tail (effective_to IS NULL). Cancellation is atomic: cancel the
  // tail (its start Y is still future, so it was never effective truth) AND re-open
  // its predecessor from [X,Y) back to [X,∞), restoring continuity with no gap and
  // no historical rewrite. Serialized against revision + END by the SAME owning-
  // assignment FOR UPDATE lock. Returns the refreshed non-cancelled series (§12).
  async cancelCommercialRevision(
    input: {
      tenant_id: string;
      placement_process_id: string;
      revision_id: string;
      cancellation_reason_code: string;
      cancelled_by: string;
    },
    requestId: string,
  ): Promise<AssignmentCommercialView[]> {
    // Defensive write-boundary guard (the DTO also constrains the wire): only a
    // user-selectable reason may drive an explicit cancellation. The reserved
    // ASSIGNMENT_ENDED is END-reconciliation-only and is refused here (§10).
    if (!isUserCancellationReasonCode(input.cancellation_reason_code)) {
      throw new AramoError('VALIDATION_ERROR', 'cancellation_reason_code must be a user-selectable cancellation reason', 400, {
        requestId,
        details: { field: 'cancellation_reason_code' },
      });
    }

    await this.prisma.$transaction(async (tx) => {
      // §19 — lock the owning assignment FIRST (sole serialization primitive).
      const locked = await tx.$queryRawUnsafe<
        Array<{ id: string; requisition_id: string; talent_record_id: string; lifecycle_state: string | null }>
      >(
        `SELECT "id", "requisition_id", "talent_record_id", "lifecycle_state"::text AS "lifecycle_state"
           FROM "placement"."ContractAssignment"
          WHERE "tenant_id" = $1::uuid AND "placement_process_id" = $2::uuid
          FOR UPDATE`,
        input.tenant_id,
        input.placement_process_id,
      );
      const assignment = locked[0];
      if (assignment === undefined) {
        throw new AramoError('NOT_FOUND', 'No ContractAssignment for placement', 404, { requestId, details: { placement_process_id: input.placement_process_id, reason: 'assignment_not_found' } });
      }
      // §3 — a version on an ENDED assignment is never user-cancellable.
      if (assignment.lifecycle_state !== 'ACTIVE') {
        throw new AramoError('NOT_FOUND', 'No active ContractAssignment', 404, { requestId, details: { placement_process_id: input.placement_process_id, reason: 'active_assignment_not_found' } });
      }

      // Load the target WITHIN the lock, scoped to (tenant, assignment). A revision
      // that is unknown, cross-tenant, or attached to a different assignment is 404
      // (never disclose existence — §20).
      const target = await tx.assignmentRateVersion.findFirst({
        where: { tenant_id: input.tenant_id, contract_assignment_id: assignment.id, id: input.revision_id },
      });
      if (target === null) {
        throw new AramoError('NOT_FOUND', 'AssignmentRateVersion not found', 404, { requestId, details: { placement_process_id: input.placement_process_id, revision_id: input.revision_id, reason: 'revision_not_found' } });
      }

      const operationTime = await this.commercialTxInstant(tx); // L7-C: DB clock (matches the B3 re-open now() gate)
      // §3 eligibility, most-specific refusal first (all 409 with details.reason).
      if (target.cancelled_at !== null) {
        throw this.commercialConflict('already_cancelled', assignment.id, requestId);
      }
      // Must start strictly in the future — rejects current AND historical versions.
      if (target.effective_from.getTime() <= operationTime.getTime()) {
        throw this.commercialConflict('revision_not_future', assignment.id, requestId);
      }
      // Must be the OPEN tail — a bounded future version is interior; cancelling it
      // would strand a later window behind a gap (§4 interior refusal).
      if (target.effective_to !== null) {
        throw this.commercialConflict('cancellation_would_create_gap', assignment.id, requestId);
      }

      // The predecessor closed at Y = target.effective_from (§4 Vprev [X,Y)). It is
      // the single non-cancelled version whose effective_to == the tail's start.
      const predecessor = await tx.assignmentRateVersion.findFirst({
        where: { tenant_id: input.tenant_id, contract_assignment_id: assignment.id, cancelled_at: null, effective_to: target.effective_from },
      });
      if (predecessor === null) {
        // Fail-closed: a future open tail with no predecessor to re-open would leave
        // a gap. Unreachable via the B2 revision path (which always closes a
        // predecessor at Y); retained as a corruption/integrity guard.
        throw this.commercialConflict('cancellation_would_create_gap', assignment.id, requestId);
      }

      // §6 — the cancellation capability authorizes BOTH the cancellation write and
      // the future-boundary re-open; SET LOCAL, confined to this method.
      await tx.$executeRawUnsafe(`SET LOCAL app.assignment_commercial_cancellation = 'authorized'`);

      // §4 — cancel the tail FIRST (drops it from the non-cancelled overlap set),
      // THEN re-open the predecessor to [X,∞). The reverse order would transiently
      // overlap [X,∞) with the still-live tail and trip the B1 EXCLUDE.
      await tx.assignmentRateVersion.update({
        where: { id: target.id },
        data: {
          cancelled_at: operationTime,
          cancelled_by: input.cancelled_by,
          cancellation_reason_code: input.cancellation_reason_code,
        },
      });
      await tx.outboxEvent.create({
        data: this.cancelledEventData({
          tenant_id: input.tenant_id,
          placement_process_id: input.placement_process_id,
          contract_assignment_id: assignment.id,
          assignment_rate_version_id: target.id,
          original_effective_from: target.effective_from,
          cancelled_by: input.cancelled_by,
          cancellation_reason_code: input.cancellation_reason_code,
          occurred_at: operationTime,
        }),
      });
      await tx.assignmentRateVersion.update({ where: { id: predecessor.id }, data: { effective_to: null } });
    });

    // §12 — the refreshed non-cancelled series after the committed cancellation.
    return this.listAssignmentCommercialRevisions(input.tenant_id, input.placement_process_id);
  }

  // Track 6 / T6-B2 — the version-series read (B4 substrate). NON-cancelled rate
  // versions for the assignment (historical + current + future), effective_from DESC.
  // Visibility is enforced by the caller loading the placement through findByIdForActor
  // FIRST (house pattern); a placement with no assignment returns an EMPTY series. This
  // is the uncapped per-assignment series — NOT the point-in-time resolver (no
  // fail-closed on multiplicity). Cancelled rows are excluded in B2 (B3 owns any
  // cancellation-audit view). Derived metrics remain the ONE canonical formula.
  async listAssignmentCommercialRevisions(
    tenant_id: string,
    placement_process_id: string,
  ): Promise<AssignmentCommercialView[]> {
    const assignment = await this.prisma.contractAssignment.findFirst({
      where: { tenant_id, placement_process_id },
      select: { id: true, requisition_id: true, talent_record_id: true },
    });
    if (assignment === null) return [];
    const versions = await this.prisma.assignmentRateVersion.findMany({
      where: { tenant_id, contract_assignment_id: assignment.id, cancelled_at: null },
      orderBy: { effective_from: 'desc' },
    });
    return versions.map((v) => {
      const metrics = deriveCommercialMetrics(v.pay_rate_amount, v.bill_rate_amount);
      return {
        contract_assignment_id: assignment.id,
        assignment_rate_version_id: v.id,
        requisition_id: assignment.requisition_id,
        talent_record_id: assignment.talent_record_id,
        pay_rate_amount: v.pay_rate_amount.toFixed(2),
        bill_rate_amount: v.bill_rate_amount.toFixed(2),
        currency: v.currency,
        rate_period: v.rate_period,
        spread_amount: metrics.spread_amount,
        margin_percent: metrics.margin_percent,
        markup_percent: metrics.markup_percent,
        effective_from: v.effective_from,
        effective_to: v.effective_to,
        change_reason: v.change_reason,
        recorded_by: v.recorded_by,
        created_at: v.created_at,
      };
    });
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

  // Track 6 / T6-B3 — the single 409 for a commercial-lifecycle state conflict
  // (§20). NO new ErrorCode: the reused ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT
  // carries the machine-readable discriminator in details.reason. The closed reason
  // set spans B2 (duplicate_effective_from | window_overlap) and B3 (already_cancelled
  // | revision_not_future | cancellation_would_create_gap). No raw Prisma/PG/trigger
  // error ever reaches the caller.
  private commercialConflict(
    reason:
      | 'duplicate_effective_from'
      | 'window_overlap'
      | 'already_cancelled'
      | 'revision_not_future'
      | 'cancellation_would_create_gap',
    contract_assignment_id: string,
    requestId: string,
  ): AramoError {
    return new AramoError('ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT', `commercial revision conflict: ${reason}`, 409, {
      requestId,
      details: { contract_assignment_id, reason },
    });
  }

  // Track 6 / T6-B3 — the rate_version.cancelled outbox row (§21). Identity/
  // provenance ONLY: NO pay/bill/spread/margin/markup/currency/rate_period. The
  // cancellation reason + original effective_from are provenance, not money. Shared
  // by explicit cancellation (one event) and END reconciliation (one per cancelled
  // version). Pure builder — the caller writes it inside the governed transaction.
  private cancelledEventData(args: {
    tenant_id: string;
    placement_process_id: string;
    contract_assignment_id: string;
    assignment_rate_version_id: string;
    original_effective_from: Date;
    cancelled_by: string;
    cancellation_reason_code: string;
    occurred_at: Date;
  }) {
    return {
      id: uuidv7(),
      tenant_id: args.tenant_id,
      event_type: OUTBOX_RATE_VERSION_CANCELLED,
      event_payload: {
        tenant_id: args.tenant_id,
        placement_process_id: args.placement_process_id,
        contract_assignment_id: args.contract_assignment_id,
        assignment_rate_version_id: args.assignment_rate_version_id,
        cancelled_by: args.cancelled_by,
        cancellation_reason_code: args.cancellation_reason_code,
        original_effective_from: args.original_effective_from.toISOString(),
        occurred_at: args.occurred_at.toISOString(),
      },
    };
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
