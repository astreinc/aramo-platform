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
    created_at: row.created_at,
  };
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

    try {
      const row = (await this.prisma.placementProcess.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          submittal_id: input.submittal_id,
          requisition_id: input.requisition_id,
          talent_record_id: input.talent_record_id,
          state: INITIAL_STATE,
        },
      })) as PlacementProcessRow;
      return projectView(row);
    } catch (err) {
      // Race-safe floor: the BEFORE INSERT trigger rejected a concurrent
      // second live attempt.
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
