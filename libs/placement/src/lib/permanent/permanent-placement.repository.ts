import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  canTransitionPermanentPlacement,
  type PermanentPlacementState,
  type RemedyPolicy,
} from '../lifecycle/placement-lifecycle.js';
import type { PermanentPlacementView } from '../placement-process.types.js';

// Track 7 / T7-P1 — the PermanentPlacement aggregate repository: the guarantee
// read surface and the happy-path lifecycle transition (GUARANTEE_ACTIVE ->
// GUARANTEE_SATISFIED). Materialisation of a PermanentPlacement at the Placement
// STARTED handoff lives in PlacementRepository.transition (the single transaction
// owner, atomic with the PlacementProcess state change) — NOT here. Tenant-scoped
// throughout; a cross-tenant read returns null (the caller maps to 404).
//
// The guarantee outbox event families (directive §12) — generic lifecycle events,
// aggregate identity in the payload (the placement OutboxEvent house pattern). NO
// PII: IDs, tenant-safe refs, state, and governed snapshot facts only.
export const OUTBOX_PERMANENT_PLACEMENT_CREATED = 'permanent_placement.created';
export const OUTBOX_PERMANENT_PLACEMENT_GUARANTEE_ACTIVE = 'permanent_placement.guarantee_active';
export const OUTBOX_PERMANENT_PLACEMENT_GUARANTEE_SATISFIED = 'permanent_placement.guarantee_satisfied';

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
}

export function projectPermanentPlacementView(row: PermanentPlacementRow): PermanentPlacementView {
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
  };
}

@Injectable()
export class PermanentPlacementRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Read the PermanentPlacement of a placement (tenant-scoped). The caller (the
  // controller) has already resolved actor visibility on the parent placement via
  // findByIdForActor (404 — never 403), so this is a coherent tenant read; a
  // visible placement with no PermanentPlacement returns null (coherent absence).
  async findByPlacement(tenant_id: string, placement_process_id: string): Promise<PermanentPlacementView | null> {
    const row = (await this.prisma.permanentPlacement.findFirst({
      where: { tenant_id, placement_process_id },
    })) as PermanentPlacementRow | null;
    return row === null ? null : projectPermanentPlacementView(row);
  }

  // Generic governed guarantee-lifecycle transition (directive §14 — one generic
  // transition contract, not named outcome routes). P1 legal edge:
  // GUARANTEE_ACTIVE -> GUARANTEE_SATISFIED, allowed ONLY on/after the guarantee
  // end date (§5 / §127). No falloff/remedy path in P1. The state flip, the
  // append-only event, and the outbox event commit atomically. Typed-map enforced
  // (§3.3) — a structurally illegal target (incl. a second satisfy, or an attempt
  // to re-enter GUARANTEE_ACTIVE) is PERMANENT_PLACEMENT_STATE_INVALID (422); a
  // premature satisfy is PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID (422).
  async transition(
    input: { tenant_id: string; placement_process_id: string; to: PermanentPlacementState },
    requestId: string,
  ): Promise<PermanentPlacementView> {
    const { to } = input;
    const current = (await this.prisma.permanentPlacement.findFirst({
      where: { tenant_id: input.tenant_id, placement_process_id: input.placement_process_id },
    })) as PermanentPlacementRow | null;
    if (current === null) {
      throw new AramoError('PERMANENT_PLACEMENT_NOT_FOUND', 'PermanentPlacement not found', 404, {
        requestId,
        details: { placement_process_id: input.placement_process_id, reason: 'permanent_placement_not_found' },
      });
    }

    if (!canTransitionPermanentPlacement(current.lifecycle_state, to)) {
      throw new AramoError('PERMANENT_PLACEMENT_STATE_INVALID', 'illegal permanent-placement guarantee transition', 422, {
        requestId,
        details: {
          permanent_placement_id: current.id,
          from_state: current.lifecycle_state,
          to_state: to,
          reason: 'illegal_transition',
        },
      });
    }

    // Satisfaction is allowed only on/after the guarantee end date (§5 / §127).
    // Calendar comparison in UTC — today's date vs the half-open end.
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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
      // Transactional outbox — identity/state ONLY, NO PII, NO monetary detail
      // beyond the governed exposure summary the create event already announced.
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: OUTBOX_PERMANENT_PLACEMENT_GUARANTEE_SATISFIED,
          event_payload: {
            tenant_id: input.tenant_id,
            permanent_placement_id: current.id,
            placement_process_id: current.placement_process_id,
            requisition_id: current.requisition_id,
            talent_record_id: current.talent_record_id,
            from_state: current.lifecycle_state,
            to_state: to,
            occurred_at: new Date().toISOString(),
          },
        },
      });
      return u;
    });
    return projectPermanentPlacementView(updated);
  }
}
