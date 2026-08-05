import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';
import {
  canTransition,
  DUPLICATE_GUARD_INACTIVE,
  INITIAL_STATE,
  type PlacementState,
} from './lifecycle/placement-lifecycle.js';
import type {
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
    // Pre-emptive guard: a live attempt is any state NOT in
    // DUPLICATE_GUARD_INACTIVE (STARTED is ENGAGED, still live).
    const live = (await this.prisma.placementProcess.findFirst({
      where: {
        tenant_id: input.tenant_id,
        submittal_id: input.submittal_id,
        state: { notIn: [...DUPLICATE_GUARD_INACTIVE] },
      },
    })) as PlacementProcessRow | null;
    if (live !== null) {
      throw this.alreadyLive(input, requestId, live.id);
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
          },
        })) as PlacementProcessRow;
        await tx.outboxEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            event_type: OUTBOX_CREATED,
            // Non-sensitive operational offer snapshot — NO commercial rates,
            // restricted evidence, or authorization detail (9-c-2).
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
              offer_terms_summary: created.offer_terms_summary,
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
          },
        });
        // Transactional outbox (9-c-2): a placement.process.state_changed event
        // commits atomically with the state change. A rejected/illegal edge never
        // reaches here, so no event is written for it.
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
              occurred_at: new Date().toISOString(),
            },
          },
        });
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

  async findById(tenant_id: string, id: string): Promise<PlacementProcessView | null> {
    const row = (await this.prisma.placementProcess.findFirst({
      where: { tenant_id, id },
    })) as PlacementProcessRow | null;
    return row === null ? null : projectView(row);
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
