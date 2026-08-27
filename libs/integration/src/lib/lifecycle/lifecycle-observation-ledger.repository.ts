import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

import type { LifecycleOrderingConfidence } from './lifecycle-source-adapter.port.js';

// CB-D2-A1 (ADR-0030) — the provider-neutral lifecycle-observation idempotency +
// ordering ledger repository. Mirrors the DeliveryLedgerPort reserve/findByKey/
// markProcessed shape, but lifecycle-appropriate (NO import_batch_id — a lifecycle
// observation drives a governed COMMAND, never an ImportBatch). The UNIQUE
// (tenant_id, connection_id, observation_key) row is the idempotency AUTHORITY
// (A0-R5). R-ORDER staleness is checked over the prior PROCESSED rows for
// (tenant, connection, external_req_id).

export interface LifecycleObservationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly external_req_id: string;
  readonly observation_key: string;
  readonly raw_provider_status: string;
  readonly ordering_confidence: LifecycleOrderingConfidence;
  readonly provider_sequence: number | null;
  readonly provider_event_at: Date | null;
  readonly observed_at: Date;
  readonly status: string;
  readonly outcome: string | null;
  readonly detail_code: string | null;
  readonly processed_at: Date | null;
}

export interface LifecycleObservationReservation {
  /** true → this caller inserted the pending row; false → a row already existed. */
  readonly reserved: boolean;
  readonly row: LifecycleObservationRow;
}

/** The last-accepted (PROCESSED) observation/event for an external requisition. */
export interface LastAcceptedObservation {
  readonly ordering_confidence: LifecycleOrderingConfidence;
  readonly provider_sequence: number | null;
  readonly provider_event_at: Date | null;
  readonly observed_at: Date;
}

interface LedgerDbRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  external_req_id: string;
  observation_key: string;
  raw_provider_status: string;
  ordering_confidence: string;
  provider_sequence: bigint | null;
  provider_event_at: Date | null;
  observed_at: Date;
  status: string;
  outcome: string | null;
  detail_code: string | null;
  processed_at: Date | null;
}

function toRow(r: LedgerDbRow): LifecycleObservationRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    connection_id: r.connection_id,
    external_req_id: r.external_req_id,
    observation_key: r.observation_key,
    raw_provider_status: r.raw_provider_status,
    ordering_confidence: r.ordering_confidence as LifecycleOrderingConfidence,
    provider_sequence: r.provider_sequence === null ? null : Number(r.provider_sequence),
    provider_event_at: r.provider_event_at,
    observed_at: r.observed_at,
    status: r.status,
    outcome: r.outcome,
    detail_code: r.detail_code,
    processed_at: r.processed_at,
  };
}

/** True for a Prisma unique-constraint violation (P2002, incl. Prisma-7 driver shape). */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: string;
    meta?: { driverAdapterError?: { cause?: { code?: string } } };
  };
  return e.code === 'P2002' || e.meta?.driverAdapterError?.cause?.code === '23505';
}

export interface ReserveObservationArgs {
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly external_req_id: string;
  readonly observation_key: string;
  readonly raw_provider_status: string;
  readonly ordering_confidence: LifecycleOrderingConfidence;
  readonly provider_sequence: number | null;
  readonly provider_event_at: Date | null;
  readonly observed_at: Date;
}

@Injectable()
export class LifecycleObservationLedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByKey(
    tenantId: string,
    connectionId: string,
    observationKey: string,
  ): Promise<LifecycleObservationRow | null> {
    const row = (await this.prisma.lifecycleObservationLedger.findUnique({
      where: {
        tenant_id_connection_id_observation_key: {
          tenant_id: tenantId,
          connection_id: connectionId,
          observation_key: observationKey,
        },
      },
    })) as LedgerDbRow | null;
    return row === null ? null : toRow(row);
  }

  /**
   * Persist the raw observation as a `pending` row BEFORE any downstream command
   * (R-DURABILITY — replay-safe). The unique constraint makes this the race-safe
   * idempotency authority: a concurrent/redelivered same-key insert yields
   * `reserved:false` plus the existing row.
   */
  async reserve(args: ReserveObservationArgs): Promise<LifecycleObservationReservation> {
    try {
      const row = (await this.prisma.lifecycleObservationLedger.create({
        data: {
          tenant_id: args.tenant_id,
          connection_id: args.connection_id,
          external_req_id: args.external_req_id,
          observation_key: args.observation_key,
          raw_provider_status: args.raw_provider_status,
          ordering_confidence: args.ordering_confidence,
          provider_sequence:
            args.provider_sequence === null ? null : BigInt(args.provider_sequence),
          provider_event_at: args.provider_event_at,
          observed_at: args.observed_at,
          status: 'pending',
        },
      })) as LedgerDbRow;
      return { reserved: true, row: toRow(row) };
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await this.findByKey(
          args.tenant_id,
          args.connection_id,
          args.observation_key,
        );
        if (existing !== null) {
          return { reserved: false, row: existing };
        }
      }
      throw err;
    }
  }

  /** The governed command ran (whatever the outcome) — mark the observation processed. */
  async markProcessed(id: string, outcome: string): Promise<void> {
    await this.prisma.lifecycleObservationLedger.update({
      where: { id },
      data: { status: 'processed', outcome, processed_at: new Date() },
    });
  }

  /** The observation was routed to the reconciliation queue (unresolved / stale). */
  async markReconciled(id: string, detailCode: string): Promise<void> {
    await this.prisma.lifecycleObservationLedger.update({
      where: { id },
      data: {
        status: 'reconciled',
        outcome: `RECONCILED:${detailCode}`,
        detail_code: detailCode,
        processed_at: new Date(),
      },
    });
  }

  /**
   * R-ORDER — the last-accepted (PROCESSED) observation/event for an external
   * requisition on this connection, for staleness checks. Ordered by
   * provider_sequence (STRONG/BOUNDED), then provider_event_at, then observed_at.
   */
  async lastAcceptedFor(
    tenantId: string,
    connectionId: string,
    externalReqId: string,
  ): Promise<LastAcceptedObservation | null> {
    const row = (await this.prisma.lifecycleObservationLedger.findFirst({
      where: {
        tenant_id: tenantId,
        connection_id: connectionId,
        external_req_id: externalReqId,
        status: 'processed',
      },
      orderBy: [
        { provider_sequence: 'desc' },
        { provider_event_at: 'desc' },
        { observed_at: 'desc' },
      ],
    })) as LedgerDbRow | null;
    if (row === null) return null;
    return {
      ordering_confidence: row.ordering_confidence as LifecycleOrderingConfidence,
      provider_sequence: row.provider_sequence === null ? null : Number(row.provider_sequence),
      provider_event_at: row.provider_event_at,
      observed_at: row.observed_at,
    };
  }
}
