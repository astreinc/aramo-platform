import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import type { InboxOutcomeCode } from './types.js';

export interface InboxRow {
  id: string;
  placement_event_id: string;
  tenant_id: string;
  event_type: string;
  status: string;
  outcome_code: string | null;
  reserved_at: Date;
  processed_at: Date | null;
  created_at: Date;
}

// The reservation disposition — the idempotency + retry authority:
//   'created'   — this caller freshly inserted the row; drive the command.
//   'pending'   — the row already exists but is NOT yet processed (a prior transient
//                 failure, or a concurrent in-flight attempt); safe to RE-ATTEMPT the
//                 command (the Pipeline command is itself CAS-guarded + recognized-
//                 satisfied on replay, so a double-attempt converges).
//   'processed' — the row is a terminal (a genuine duplicate delivery of an event
//                 already acted on); SUCCESS NO-OP — never re-process.
export type ReserveResult =
  | { readonly disposition: 'created'; readonly row: InboxRow }
  | { readonly disposition: 'pending'; readonly row: InboxRow }
  | { readonly disposition: 'processed'; readonly row: InboxRow };

// Lane 2 / L2-G (Part 3) — the idempotent-consumer inbox. `reserve` is the idempotency
// boundary: the UNIQUE placement_event_id makes a re-delivered same-event insert converge
// on the existing row. A PROCESSED row is a success no-op (never re-processed); a still-
// PENDING row is retry-safe (re-attempted). `markProcessed` is called ONLY after the
// Pipeline command succeeds or reaches a recognized-satisfied state; a transient failure
// leaves the row `pending` so a later drain re-picks it. The bridge owns bookkeeping only
// — it neither reads Placement/Pipeline nor holds any lifecycle rule.
@Injectable()
export class PlacementPipelineInboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(args: {
    placement_event_id: string;
    tenant_id: string;
    event_type: string;
  }): Promise<ReserveResult> {
    try {
      const row = (await this.prisma.placementPipelineInbox.create({
        data: {
          id: uuidv7(),
          placement_event_id: args.placement_event_id,
          tenant_id: args.tenant_id,
          event_type: args.event_type,
          status: 'pending',
        },
      })) as InboxRow;
      // The insert succeeded → this caller freshly reserved the event; process it.
      return { disposition: 'created', row };
    } catch (err) {
      if (isUniqueViolation(err)) {
        // The row already exists (redelivery / prior attempt). A PROCESSED row is a no-op;
        // a still-pending row is retry-safe.
        const existing = (await this.prisma.placementPipelineInbox.findUnique({
          where: { placement_event_id: args.placement_event_id },
        })) as InboxRow | null;
        if (existing !== null) {
          return existing.status === 'processed'
            ? { disposition: 'processed', row: existing }
            : { disposition: 'pending', row: existing };
        }
      }
      throw err;
    }
  }

  // Mark a reserved row processed with a classified outcome (idempotent: only flips a
  // still-pending row; a concurrent double-mark is a no-op).
  async markProcessed(args: {
    placement_event_id: string;
    outcome_code: InboxOutcomeCode;
  }): Promise<void> {
    await this.prisma.placementPipelineInbox.updateMany({
      where: { placement_event_id: args.placement_event_id, status: 'pending' },
      data: {
        status: 'processed',
        outcome_code: args.outcome_code,
        processed_at: new Date(),
      },
    });
  }

  async findByEventId(placement_event_id: string): Promise<InboxRow | null> {
    return (await this.prisma.placementPipelineInbox.findUnique({
      where: { placement_event_id },
    })) as InboxRow | null;
  }
}

// P2002 / Postgres 23505 unique-violation shape (Prisma-7 / PrismaPg driver-adapter).
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { code?: unknown } } };
  };
  return (
    e.code === 'P2002' ||
    e.meta?.driverAdapterError?.cause?.code === '23505'
  );
}
