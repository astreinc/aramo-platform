import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';

import { Prisma } from '../../../prisma/generated/client/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  canTransitionPermanentPlacement,
  dueStateForRemedyPolicy,
  REMEDY_DUE_STATES,
  type PermanentPlacementState,
  type RemedyPolicy,
} from '../lifecycle/placement-lifecycle.js';
import { isPermanentFalloffReasonCode } from '../reasons/permanent-falloff-reasons.js';
import type {
  FalloffInput,
  PermanentPlacementRemedyView,
  PermanentPlacementView,
  RemedyCompletionInput,
} from '../placement-process.types.js';

import { parseCalendarDate } from './guarantee-validation.js';
import { computeRemedyObligation } from './remedy-computation.js';

// Track 7 — PermanentPlacement aggregate repository. P1: guarantee read + happy-path
// GUARANTEE_ACTIVE -> GUARANTEE_SATISFIED. T7-P2: the atomic governed falloff command
// (FELL_OFF -> deterministic remedy-due, §3.2) and the evidence-gated remedy completion
// (§9). Materialisation at the STARTED handoff lives in PlacementRepository.transition
// (the single transaction owner). Tenant-scoped throughout; a cross-tenant read is null.
//
// Outbox event families (§13 / §3.9) — generic lifecycle events, aggregate identity in
// the payload; NO PII, NO monetary amount, NO completion reference. Governed state/ID/
// remedy-policy/falloff-date/falloff-reason-code/occurred_at only.
export const OUTBOX_PERMANENT_PLACEMENT_CREATED = 'permanent_placement.created';
export const OUTBOX_PERMANENT_PLACEMENT_GUARANTEE_ACTIVE = 'permanent_placement.guarantee_active';
export const OUTBOX_PERMANENT_PLACEMENT_GUARANTEE_SATISFIED = 'permanent_placement.guarantee_satisfied';
export const OUTBOX_PERMANENT_PLACEMENT_FELL_OFF = 'permanent_placement.fell_off';
export const OUTBOX_PERMANENT_PLACEMENT_REMEDY_DUE = 'permanent_placement.remedy_due';
export const OUTBOX_PERMANENT_PLACEMENT_REMEDY_COMPLETED = 'permanent_placement.remedy_completed';

// A bounded external completion reference (refund/credit). Non-empty, trimmed, <= 255.
const EXTERNAL_REFERENCE_MAX = 255;

interface PermanentPlacementRow {
  id: string;
  tenant_id: string;
  placement_process_id: string;
  submittal_id: string;
  requisition_id: string;
  talent_record_id: string;
  lifecycle_state: PermanentPlacementState;
  guarantee_start_date: Date;
  guarantee_duration_days: number;
  guarantee_end_date: Date;
  remedy_policy: RemedyPolicy;
  guarantee_exposure_amount: { toFixed: (n: number) => string };
  guarantee_exposure_currency: string;
  terms_source: string;
  recorded_by: string;
  created_at: Date;
  falloff_effective_date: Date | null;
  falloff_reason: string | null;
  falloff_recorded_by: string | null;
  falloff_recorded_at: Date | null;
}

interface PermanentPlacementRemedyRow {
  id: string;
  tenant_id: string;
  permanent_placement_id: string;
  requisition_id: string;
  talent_record_id: string;
  remedy_type: RemedyPolicy;
  calculated_amount: { toFixed: (n: number) => string } | null;
  currency: string | null;
  exposure_amount_snapshot: { toFixed: (n: number) => string };
  duration_days_snapshot: number;
  remaining_days: number | null;
  falloff_effective_date: Date;
  created_by: string;
  due_at: Date;
  created_at: Date;
  completed_at: Date | null;
  completed_by: string | null;
  completion_reference: string | null;
  replacement_placement_process_id: string | null;
}

interface PlacementProcessRow {
  id: string;
  tenant_id: string;
  requisition_id: string;
  state: string;
  placement_kind: string | null;
}

function projectRemedyView(r: PermanentPlacementRemedyRow): PermanentPlacementRemedyView {
  return {
    remedy_type: r.remedy_type,
    calculated_amount: r.calculated_amount === null ? null : r.calculated_amount.toFixed(2),
    currency: r.currency,
    remaining_days: r.remaining_days,
    falloff_effective_date: r.falloff_effective_date,
    due_at: r.due_at,
    completed_at: r.completed_at,
    completed_by: r.completed_by,
    completion_reference: r.completion_reference,
    replacement_placement_process_id: r.replacement_placement_process_id,
  };
}

export function projectPermanentPlacementView(
  row: PermanentPlacementRow,
  remedy: PermanentPlacementRemedyRow | null,
): PermanentPlacementView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    placement_process_id: row.placement_process_id,
    submittal_id: row.submittal_id,
    requisition_id: row.requisition_id,
    talent_record_id: row.talent_record_id,
    lifecycle_state: row.lifecycle_state,
    guarantee_start_date: row.guarantee_start_date,
    guarantee_duration_days: row.guarantee_duration_days,
    guarantee_end_date: row.guarantee_end_date,
    remedy_policy: row.remedy_policy,
    // Decimal(12,2) -> scale-2 string (money-at-boundary; never a float).
    guarantee_exposure_amount: row.guarantee_exposure_amount.toFixed(2),
    guarantee_exposure_currency: row.guarantee_exposure_currency,
    terms_source: row.terms_source,
    recorded_by: row.recorded_by,
    created_at: row.created_at,
    falloff_effective_date: row.falloff_effective_date,
    falloff_reason: row.falloff_reason,
    falloff_recorded_by: row.falloff_recorded_by,
    falloff_recorded_at: row.falloff_recorded_at,
    remedy: remedy === null ? null : projectRemedyView(remedy),
  };
}

@Injectable()
export class PermanentPlacementRepository {
  constructor(private readonly prisma: PrismaService) {}

  private async loadPlacement(tenant_id: string, placement_process_id: string): Promise<PermanentPlacementRow | null> {
    return (await this.prisma.permanentPlacement.findFirst({
      where: { tenant_id, placement_process_id },
    })) as PermanentPlacementRow | null;
  }

  private async loadRemedy(tenant_id: string, permanent_placement_id: string): Promise<PermanentPlacementRemedyRow | null> {
    return (await this.prisma.permanentPlacementRemedy.findFirst({
      where: { tenant_id, permanent_placement_id },
    })) as PermanentPlacementRemedyRow | null;
  }

  private notFound(placement_process_id: string, requestId: string): AramoError {
    return new AramoError('PERMANENT_PLACEMENT_NOT_FOUND', 'PermanentPlacement not found', 404, {
      requestId,
      details: { placement_process_id, reason: 'permanent_placement_not_found' },
    });
  }

  // Read the PermanentPlacement of a placement + its remedy obligation (tenant-scoped).
  // The controller has already resolved actor visibility on the parent placement (404).
  async findByPlacement(tenant_id: string, placement_process_id: string): Promise<PermanentPlacementView | null> {
    const row = await this.loadPlacement(tenant_id, placement_process_id);
    if (row === null) return null;
    const remedy = await this.loadRemedy(tenant_id, row.id);
    return projectPermanentPlacementView(row, remedy);
  }

  // Generic governed guarantee-lifecycle transition (P1: GUARANTEE_ACTIVE ->
  // GUARANTEE_SATISFIED, allowed only on/after the guarantee end date). The falloff +
  // remedy edges are NOT driven through this generic route — they are the dedicated
  // recordFalloff / completeRemedy commands (they carry evidence + compute money).
  async transition(
    input: { tenant_id: string; placement_process_id: string; to: PermanentPlacementState },
    requestId: string,
  ): Promise<PermanentPlacementView> {
    const { to } = input;
    const current = await this.loadPlacement(input.tenant_id, input.placement_process_id);
    if (current === null) throw this.notFound(input.placement_process_id, requestId);

    if (!canTransitionPermanentPlacement(current.lifecycle_state, to)) {
      throw this.stateInvalid(current, to, requestId);
    }

    // Satisfaction is allowed only on/after the guarantee end date (§5 / §127).
    const todayUtc = this.todayUtc();
    if (to === 'GUARANTEE_SATISFIED' && todayUtc.getTime() < current.guarantee_end_date.getTime()) {
      throw new AramoError(
        'PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID',
        'the guarantee window has not yet elapsed; satisfaction is allowed only on or after the guarantee end date',
        422,
        {
          requestId,
          details: {
            permanent_placement_id: current.id,
            reason: 'guarantee_window_not_elapsed',
            guarantee_end_date: current.guarantee_end_date.toISOString().slice(0, 10),
          },
        },
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = (await tx.permanentPlacement.update({
        where: { id: current.id },
        data: { lifecycle_state: to },
      })) as PermanentPlacementRow;
      await tx.permanentPlacementEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          permanent_placement_id: current.id,
          event_type: 'state_transition',
          event_payload: { from: current.lifecycle_state, to },
        },
      });
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: OUTBOX_PERMANENT_PLACEMENT_GUARANTEE_SATISFIED,
          event_payload: this.baseEventPayload(current, current.lifecycle_state, to),
        },
      });
      return u;
    });
    return projectPermanentPlacementView(updated, null);
  }

  // T7-P2 — the atomic governed falloff command (§3.2). Validates the falloff, persists
  // write-once falloff facts, transitions GUARANTEE_ACTIVE -> FELL_OFF, deterministically
  // maps the immutable remedy policy, creates exactly one remedy obligation, transitions
  // FELL_OFF -> the *_DUE state, and appends fell_off + remedy_due events/outbox — ALL in
  // one transaction. After commit, external reads see the deterministic due state.
  async recordFalloff(input: FalloffInput, requestId: string): Promise<PermanentPlacementView> {
    const current = await this.loadPlacement(input.tenant_id, input.placement_process_id);
    if (current === null) throw this.notFound(input.placement_process_id, requestId);

    // Falloff is valid ONLY from GUARANTEE_ACTIVE (§5) — the typed map is authority.
    if (!canTransitionPermanentPlacement(current.lifecycle_state, 'FELL_OFF')) {
      throw this.stateInvalid(current, 'FELL_OFF', requestId);
    }

    // Governed reason — exact code from the closed T7 registry, no OTHER (§3.1).
    if (!isPermanentFalloffReasonCode(input.reason)) {
      throw new AramoError('PERMANENT_PLACEMENT_FALLOFF_REASON_INVALID', 'the falloff reason is not a governed permanent-falloff code', 422, {
        requestId,
        details: { permanent_placement_id: current.id, reason: 'falloff_reason_invalid', falloff_reason: input.reason },
      });
    }

    // Window — a valid calendar date in the half-open [start, end) (§5).
    const effective = parseCalendarDate(input.effective_date);
    if (effective === null) {
      throw this.windowInvalid(current, requestId, 'effective_date_invalid', input.effective_date);
    }
    if (effective.getTime() < current.guarantee_start_date.getTime()) {
      throw this.windowInvalid(current, requestId, 'effective_date_before_start', input.effective_date);
    }
    if (effective.getTime() >= current.guarantee_end_date.getTime()) {
      throw this.windowInvalid(current, requestId, 'effective_date_on_or_after_end', input.effective_date);
    }

    // Deterministic remedy selection from the immutable snapshot (§6) — fail-closed.
    const due_state = dueStateForRemedyPolicy(current.remedy_policy);
    if (due_state === null) {
      throw new AramoError('PERMANENT_PLACEMENT_REMEDY_INVALID', 'the guarantee remedy policy is not a governed value', 422, {
        requestId,
        details: { permanent_placement_id: current.id, reason: 'remedy_policy_invalid', remedy_policy: current.remedy_policy },
      });
    }
    const obligation = computeRemedyObligation({
      remedy_policy: current.remedy_policy,
      exposure_amount: current.guarantee_exposure_amount.toFixed(2),
      exposure_currency: current.guarantee_exposure_currency,
      guarantee_duration_days: current.guarantee_duration_days,
      guarantee_end_date: current.guarantee_end_date,
      falloff_effective_date: effective,
    });

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // Step 3+4 — persist write-once falloff facts + transition ACTIVE -> FELL_OFF.
      await tx.permanentPlacement.update({
        where: { id: current.id },
        data: {
          lifecycle_state: 'FELL_OFF',
          falloff_effective_date: effective,
          falloff_reason: input.reason,
          falloff_recorded_by: input.recorded_by,
          falloff_recorded_at: now,
        },
      });
      // Step 5 — fell_off event + outbox (governed facts, no PII/money).
      await this.appendEvent(tx, current.id, input.tenant_id, current.lifecycle_state, 'FELL_OFF');
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: OUTBOX_PERMANENT_PLACEMENT_FELL_OFF,
          event_payload: {
            ...this.baseEventPayload(current, current.lifecycle_state, 'FELL_OFF'),
            falloff_effective_date: effective.toISOString().slice(0, 10),
            falloff_reason: input.reason,
          },
        },
      });
      // Step 7 — create exactly one remedy obligation (immutable facts).
      await tx.permanentPlacementRemedy.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          permanent_placement_id: current.id,
          requisition_id: current.requisition_id,
          talent_record_id: current.talent_record_id,
          remedy_type: obligation.remedy_type,
          calculated_amount: obligation.calculated_amount,
          currency: obligation.currency,
          exposure_amount_snapshot: current.guarantee_exposure_amount.toFixed(2),
          duration_days_snapshot: current.guarantee_duration_days,
          remaining_days: obligation.remaining_days,
          falloff_effective_date: effective,
          created_by: input.recorded_by,
          due_at: now,
        },
      });
      // Step 8+9 — transition FELL_OFF -> *_DUE + remedy_due event/outbox.
      const u = (await tx.permanentPlacement.update({
        where: { id: current.id },
        data: { lifecycle_state: due_state },
      })) as PermanentPlacementRow;
      await this.appendEvent(tx, current.id, input.tenant_id, 'FELL_OFF', due_state);
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: OUTBOX_PERMANENT_PLACEMENT_REMEDY_DUE,
          event_payload: {
            ...this.baseEventPayload(current, 'FELL_OFF', due_state),
            remedy_policy: current.remedy_policy,
            falloff_effective_date: effective.toISOString().slice(0, 10),
          },
        },
      });
      return u;
    });
    const remedy = await this.loadRemedy(input.tenant_id, current.id);
    return projectPermanentPlacementView(updated, remedy);
  }

  // T7-P2 — evidence-gated remedy completion (§9). Requires the aggregate in a *_DUE
  // state and the remedy scope (enforced at the controller). Validates evidence by
  // remedy type, writes the completion facts once, transitions to REMEDY_COMPLETED, and
  // appends event/outbox — atomically. Double completion is a deterministic conflict.
  async completeRemedy(input: RemedyCompletionInput, requestId: string): Promise<PermanentPlacementView> {
    const current = await this.loadPlacement(input.tenant_id, input.placement_process_id);
    if (current === null) throw this.notFound(input.placement_process_id, requestId);
    const remedy = await this.loadRemedy(input.tenant_id, current.id);
    if (remedy === null) throw this.notFound(input.placement_process_id, requestId);

    // Already completed -> deterministic conflict (§9).
    if (remedy.completed_at !== null || current.lifecycle_state === 'REMEDY_COMPLETED') {
      throw new AramoError('PERMANENT_PLACEMENT_REMEDY_ALREADY_COMPLETED', 'the remedy obligation is already completed', 409, {
        requestId,
        details: { permanent_placement_id: current.id, reason: 'remedy_already_completed' },
      });
    }
    // Must be in a remedy-due state.
    if (!(REMEDY_DUE_STATES as readonly string[]).includes(current.lifecycle_state)) {
      throw this.stateInvalid(current, 'REMEDY_COMPLETED', requestId);
    }

    // Validate evidence by the immutable remedy type (§3.5 / §9).
    const completion = await this.validateCompletionEvidence(current, remedy, input, requestId);

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.permanentPlacementRemedy.update({
        where: { id: remedy.id },
        data: {
          completed_at: now,
          completed_by: input.completed_by,
          completion_reference: completion.completion_reference,
          replacement_placement_process_id: completion.replacement_placement_process_id,
        },
      });
      const u = (await tx.permanentPlacement.update({
        where: { id: current.id },
        data: { lifecycle_state: 'REMEDY_COMPLETED' },
      })) as PermanentPlacementRow;
      await this.appendEvent(tx, current.id, input.tenant_id, current.lifecycle_state, 'REMEDY_COMPLETED');
      // Outbox — NO amount, NO completion reference (§3.9). State/IDs/remedy-policy only.
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: OUTBOX_PERMANENT_PLACEMENT_REMEDY_COMPLETED,
          event_payload: {
            ...this.baseEventPayload(current, current.lifecycle_state, 'REMEDY_COMPLETED'),
            remedy_policy: current.remedy_policy,
          },
        },
      });
      return u;
    });
    const refreshed = await this.loadRemedy(input.tenant_id, current.id);
    return projectPermanentPlacementView(updated, refreshed);
  }

  // Evidence validation (§3.5). REPLACEMENT requires a governed replacement placement
  // linkage (evidence only, NOT an E4 predecessor relation — E4 unchanged). REFUND /
  // PRORATED_CREDIT require a bounded non-empty external reference. Caller supplies no
  // amount. Returns the coherent completion field set or throws PERMANENT_PLACEMENT_REMEDY_INVALID.
  private async validateCompletionEvidence(
    placement: PermanentPlacementRow,
    remedy: PermanentPlacementRemedyRow,
    input: RemedyCompletionInput,
    requestId: string,
  ): Promise<{ completion_reference: string | null; replacement_placement_process_id: string | null }> {
    const remedyInvalid = (reason: string, extra: Record<string, unknown> = {}): AramoError =>
      new AramoError('PERMANENT_PLACEMENT_REMEDY_INVALID', 'the remedy completion evidence is invalid', 422, {
        requestId,
        details: { permanent_placement_id: placement.id, remedy_type: remedy.remedy_type, reason, ...extra },
      });

    if (remedy.remedy_type === 'REPLACEMENT') {
      const replacementId = input.replacement_placement_process_id;
      if (input.external_reference != null) throw remedyInvalid('external_reference_not_allowed_for_replacement');
      if (!replacementId) throw remedyInvalid('replacement_placement_process_id_required');
      if (replacementId === placement.placement_process_id) throw remedyInvalid('replacement_must_differ_from_original');
      const rep = (await this.prisma.placementProcess.findFirst({
        where: { tenant_id: placement.tenant_id, id: replacementId },
        select: { id: true, tenant_id: true, requisition_id: true, state: true, placement_kind: true },
      })) as PlacementProcessRow | null;
      // Cross-tenant / unknown folds to not-found evidence (least-visibility).
      if (rep === null) throw remedyInvalid('replacement_not_found', { replacement_placement_process_id: replacementId });
      if (rep.requisition_id !== placement.requisition_id) throw remedyInvalid('replacement_wrong_requisition');
      if (rep.placement_kind !== 'PERMANENT') throw remedyInvalid('replacement_not_permanent');
      if (rep.state !== 'STARTED') throw remedyInvalid('replacement_not_started');
      return { completion_reference: null, replacement_placement_process_id: replacementId };
    }

    // REFUND / PRORATED_CREDIT — bounded non-empty external reference, no replacement id.
    if (input.replacement_placement_process_id != null) throw remedyInvalid('replacement_id_not_allowed_for_monetary_remedy');
    const ref = typeof input.external_reference === 'string' ? input.external_reference.trim() : '';
    if (ref.length === 0) throw remedyInvalid('external_reference_required');
    if (ref.length > EXTERNAL_REFERENCE_MAX) throw remedyInvalid('external_reference_too_long');
    return { completion_reference: ref, replacement_placement_process_id: null };
  }

  // --- shared helpers ---

  private async appendEvent(
    tx: Prisma.TransactionClient,
    permanent_placement_id: string,
    tenant_id: string,
    from: PermanentPlacementState,
    to: PermanentPlacementState,
  ): Promise<void> {
    await tx.permanentPlacementEvent.create({
      data: {
        id: uuidv7(),
        tenant_id,
        permanent_placement_id,
        event_type: 'state_transition',
        event_payload: { from, to },
      },
    });
  }

  private baseEventPayload(
    row: PermanentPlacementRow,
    from: PermanentPlacementState,
    to: PermanentPlacementState,
  ): Prisma.InputJsonObject {
    return {
      tenant_id: row.tenant_id,
      permanent_placement_id: row.id,
      placement_process_id: row.placement_process_id,
      requisition_id: row.requisition_id,
      talent_record_id: row.talent_record_id,
      from_state: from,
      to_state: to,
      occurred_at: new Date().toISOString(),
    };
  }

  private todayUtc(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private stateInvalid(current: PermanentPlacementRow, to: PermanentPlacementState, requestId: string): AramoError {
    return new AramoError('PERMANENT_PLACEMENT_STATE_INVALID', 'illegal permanent-placement guarantee transition', 422, {
      requestId,
      details: {
        permanent_placement_id: current.id,
        from_state: current.lifecycle_state,
        to_state: to,
        reason: 'illegal_transition',
      },
    });
  }

  private windowInvalid(current: PermanentPlacementRow, requestId: string, reason: string, effective_date: string): AramoError {
    return new AramoError('PERMANENT_PLACEMENT_FALLOFF_WINDOW_INVALID', 'the falloff effective date is outside the guarantee window', 422, {
      requestId,
      details: {
        permanent_placement_id: current.id,
        reason,
        falloff_effective_date: effective_date,
        guarantee_start_date: current.guarantee_start_date.toISOString().slice(0, 10),
        guarantee_end_date: current.guarantee_end_date.toISOString().slice(0, 10),
      },
    });
  }
}
