import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

import {
  RECONCILIATION_FAILURE_REASON,
  RECONCILIATION_STATUS,
  type ReconciliationDisposition,
} from './reconciliation-failure-reason.js';

// L1-D1 (ADR-0030) — repositories for the External Lifecycle Authority substrate:
// the per-connection governed MAPPING contract, the record-then-resolve
// RECONCILIATION queue, and the immutable external-transition PROVENANCE record.
// These are pure data-access seams (no policy, no requisition write) — the
// governed transition itself runs through @aramo/requisition's command seam,
// composed by the apps/api reconciler.

/** The per-connection authority posture (ADR-0030 §4). */
export type RequisitionLifecycleAuthorityMode = 'external_authority' | 'dual_control';

/** A resolved mapping-contract entry for one provider state on one connection. */
export interface RequisitionLifecycleMappingResolved {
  readonly mapped_action: string;
  readonly mapping_version: number;
  readonly authority_mode: RequisitionLifecycleAuthorityMode;
}

interface MappingRow {
  mapped_action: string;
  mapping_version: number;
  authority_mode: RequisitionLifecycleAuthorityMode;
}

// RequisitionLifecycleMappingRepository — the governed mapping contract (seam #3).
@Injectable()
export class RequisitionLifecycleMappingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolve the mapped action + version + authority mode for a provider state. */
  async findByConnectionState(
    tenantId: string,
    connectionId: string,
    providerState: string,
  ): Promise<RequisitionLifecycleMappingResolved | null> {
    const row = (await this.prisma.requisitionLifecycleMapping.findUnique({
      where: {
        tenant_id_connection_id_provider_state: {
          tenant_id: tenantId,
          connection_id: connectionId,
          provider_state: providerState,
        },
      },
      select: { mapped_action: true, mapping_version: true, authority_mode: true },
    })) as MappingRow | null;
    return row === null
      ? null
      : {
          mapped_action: row.mapped_action,
          mapping_version: row.mapping_version,
          authority_mode: row.authority_mode,
        };
  }

  /** Author (idempotent) one connection-state mapping. Admin/test seeding. */
  async upsertMapping(args: {
    tenant_id: string;
    connection_id: string;
    provider_state: string;
    mapped_action: string;
    mapping_version?: number;
    authority_mode?: RequisitionLifecycleAuthorityMode;
  }): Promise<void> {
    const mappingVersion = args.mapping_version ?? 1;
    const authorityMode = args.authority_mode ?? 'external_authority';
    await this.prisma.requisitionLifecycleMapping.upsert({
      where: {
        tenant_id_connection_id_provider_state: {
          tenant_id: args.tenant_id,
          connection_id: args.connection_id,
          provider_state: args.provider_state,
        },
      },
      create: {
        tenant_id: args.tenant_id,
        connection_id: args.connection_id,
        provider_state: args.provider_state,
        mapped_action: args.mapped_action,
        mapping_version: mappingVersion,
        authority_mode: authorityMode,
      },
      update: {
        mapped_action: args.mapped_action,
        mapping_version: mappingVersion,
        authority_mode: authorityMode,
      },
    });
  }
}

/** One pending reconciliation row to record (D1 writes 'pending' only). */
export interface RecordReconciliationInput {
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly external_event_id: string;
  readonly external_req_id?: string | null;
  readonly provider_key: string;
  readonly raw_provider_status: string;
  readonly normalized_status?: string | null;
  readonly mapped_action?: string | null;
  readonly current_aramo_status?: string | null;
  readonly failure_reason: string;
}

interface ReconciliationRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  external_event_id: string;
  failure_reason: string;
  status: string;
  mapped_action: string | null;
  current_aramo_status: string | null;
}

/**
 * The FULL claimed-row shape the CB-D2-R worker needs to re-run the governed
 * path — the identity facts (external_req_id/provider_key), the provider facts
 * (raw/normalized status + mapped_action), the last-seen current status, and the
 * bounded attempt counter (post-claim-increment) that drives the poison cap.
 */
export interface ClaimedReconciliationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly external_event_id: string;
  readonly external_req_id: string | null;
  readonly provider_key: string;
  readonly raw_provider_status: string;
  readonly normalized_status: string | null;
  readonly mapped_action: string | null;
  readonly current_aramo_status: string | null;
  readonly failure_reason: string;
  readonly attempts: number;
  // When the row entered reconciliation — the best-available external-event time
  // for the re-attempt provenance record (the row does not store the raw event
  // timestamp; created_at is the Aramo-side observation time).
  readonly created_at: Date;
}

// The RETURNING projection shape from claimDuePending's raw statement.
interface ClaimedDbRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  external_event_id: string;
  external_req_id: string | null;
  provider_key: string;
  raw_provider_status: string;
  normalized_status: string | null;
  mapped_action: string | null;
  current_aramo_status: string | null;
  failure_reason: string;
  attempts: number | bigint;
  created_at: Date;
}

// RequisitionExternalReconciliationRepository — the record-then-resolve queue
// (seam #4). D1 WRITES pending rows; the draining WORKER is D2.
@Injectable()
export class RequisitionExternalReconciliationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a pending reconciliation row, idempotent on the external event id.
   * A redelivered event resolves to the existing pending row (no duplicate).
   */
  async recordPending(input: RecordReconciliationInput): Promise<ReconciliationRow> {
    const row = (await this.prisma.requisitionExternalReconciliation.upsert({
      where: {
        tenant_id_connection_id_external_event_id: {
          tenant_id: input.tenant_id,
          connection_id: input.connection_id,
          external_event_id: input.external_event_id,
        },
      },
      create: {
        tenant_id: input.tenant_id,
        connection_id: input.connection_id,
        external_event_id: input.external_event_id,
        external_req_id: input.external_req_id ?? null,
        provider_key: input.provider_key,
        raw_provider_status: input.raw_provider_status,
        normalized_status: input.normalized_status ?? null,
        mapped_action: input.mapped_action ?? null,
        current_aramo_status: input.current_aramo_status ?? null,
        failure_reason: input.failure_reason,
        status: 'pending',
      },
      // Idempotent redelivery — the pending row is authoritative; do not
      // overwrite it (a D2 concern, not D1).
      update: {},
    })) as ReconciliationRow;
    return row;
  }

  /** Read one reconciliation row by external event (tenant-scoped). */
  async findByExternalEvent(
    tenantId: string,
    connectionId: string,
    externalEventId: string,
  ): Promise<ReconciliationRow | null> {
    return (await this.prisma.requisitionExternalReconciliation.findUnique({
      where: {
        tenant_id_connection_id_external_event_id: {
          tenant_id: tenantId,
          connection_id: connectionId,
          external_event_id: externalEventId,
        },
      },
    })) as ReconciliationRow | null;
  }

  // ---------------------------------------------------------------------------
  // CB-D2-R (ADR-0030) — the DRAIN seam. The worker claims a bounded batch of due
  // pending rows under a lease, then per row EITHER re-runs the governed command
  // (RE_EVALUABLE), marks resolved (SUPERSEDED), or parks/bumps (INTERVENTION /
  // poison). These are pure data-access seams — no requisition write, no policy.
  // ---------------------------------------------------------------------------

  /**
   * Atomic, concurrency-safe lease claim of the oldest due pending rows. A single
   * UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING statement:
   * two concurrent drains never claim the same row (SKIP LOCKED), and the claim
   * increments attempts + stamps the lease in the same statement.
   *
   * Excluded from the poll: DUAL_CONTROL_PENDING (awaits a future control
   * workflow), parked rows (terminal intervention — status <> 'pending'), rows
   * backing off (next_attempt_at in the future), and rows under a live lease.
   */
  async claimDuePending(args: {
    limit: number;
    lockedBy: string;
    leaseMs: number;
  }): Promise<ClaimedReconciliationRow[]> {
    const rows = await this.prisma.$queryRawUnsafe<ClaimedDbRow[]>(
      `UPDATE "integration"."RequisitionExternalReconciliation" AS r
          SET locked_until = now() + make_interval(secs => $1::double precision / 1000.0),
              locked_by = $2,
              attempts = r.attempts + 1
        WHERE r.id IN (
          SELECT c.id
            FROM "integration"."RequisitionExternalReconciliation" AS c
           WHERE c.status = $3
             AND c.failure_reason <> $4
             AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
             AND (c.locked_until IS NULL OR c.locked_until < now())
           ORDER BY c.created_at ASC
           LIMIT $5
           FOR UPDATE SKIP LOCKED
        )
      RETURNING r.id, r.tenant_id, r.connection_id, r.external_event_id,
                r.external_req_id, r.provider_key, r.raw_provider_status,
                r.normalized_status, r.mapped_action, r.current_aramo_status,
                r.failure_reason, r.attempts, r.created_at`,
      args.leaseMs,
      args.lockedBy,
      RECONCILIATION_STATUS.PENDING,
      RECONCILIATION_FAILURE_REASON.DUAL_CONTROL_PENDING,
      args.limit,
    );
    return rows.map((r) => ({
      id: r.id,
      tenant_id: r.tenant_id,
      connection_id: r.connection_id,
      external_event_id: r.external_event_id,
      external_req_id: r.external_req_id,
      provider_key: r.provider_key,
      raw_provider_status: r.raw_provider_status,
      normalized_status: r.normalized_status,
      mapped_action: r.mapped_action,
      current_aramo_status: r.current_aramo_status,
      failure_reason: r.failure_reason,
      // Postgres INTEGER surfaces as a JS number through the pg driver.
      attempts: Number(r.attempts),
      created_at: r.created_at,
    }));
  }

  /** Terminal resolve — the worker executed (or superseded) this row; drops it
   * out of the poll and releases the lease. resolution_reason is the disposition
   * (SEPARATE column; failure_reason is untouched). */
  async markResolved(id: string, resolutionReason: ReconciliationDisposition): Promise<void> {
    await this.prisma.requisitionExternalReconciliation.update({
      where: { id },
      data: {
        status: RECONCILIATION_STATUS.RESOLVED,
        resolution_reason: resolutionReason,
        resolved_at: new Date(),
        locked_until: null,
        locked_by: null,
      },
    });
  }

  /** Terminal PARK — intervention/poison. Excluded from the poll forever
   * (status <> 'pending'); never auto-touched again. */
  async park(id: string, resolutionReason: ReconciliationDisposition): Promise<void> {
    await this.prisma.requisitionExternalReconciliation.update({
      where: { id },
      data: {
        status: RECONCILIATION_STATUS.PARKED,
        resolution_reason: resolutionReason,
        locked_until: null,
        locked_by: null,
      },
    });
  }

  /** Reschedule a still-retryable row: set the backoff watermark and RELEASE the
   * lease so it is re-claimed only once due. attempts was already incremented at
   * claim time — bump never double-counts. */
  async bumpAttempt(id: string, nextAttemptAt: Date): Promise<void> {
    await this.prisma.requisitionExternalReconciliation.update({
      where: { id },
      data: {
        next_attempt_at: nextAttemptAt,
        locked_until: null,
        locked_by: null,
      },
    });
  }
}

/** One immutable external-transition provenance record to write (on EXECUTE). */
export interface RecordProvenanceInput {
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly external_event_id: string;
  readonly external_event_at: Date;
  readonly raw_provider_status: string;
  readonly normalized_status: string;
  readonly mapping_version: number;
  readonly mapped_action: string;
  readonly lifecycle_event_id: string;
  readonly policy_decision_id?: string | null;
}

interface ProvenanceRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  external_event_id: string;
  lifecycle_event_id: string;
  policy_decision_id: string | null;
  mapping_version: number;
  mapped_action: string;
}

// RequisitionExternalTransitionProvenanceRepository — immutable provenance
// (seam #5). Append-only; links a governed transition to its external event.
@Injectable()
export class RequisitionExternalTransitionProvenanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordProvenanceInput): Promise<ProvenanceRow> {
    return (await this.prisma.requisitionExternalTransitionProvenance.create({
      data: {
        tenant_id: input.tenant_id,
        connection_id: input.connection_id,
        external_event_id: input.external_event_id,
        external_event_at: input.external_event_at,
        raw_provider_status: input.raw_provider_status,
        normalized_status: input.normalized_status,
        mapping_version: input.mapping_version,
        mapped_action: input.mapped_action,
        lifecycle_event_id: input.lifecycle_event_id,
        policy_decision_id: input.policy_decision_id ?? null,
      },
    })) as ProvenanceRow;
  }

  /** Read the provenance record for one external event (tenant-scoped). */
  async findByExternalEvent(
    tenantId: string,
    connectionId: string,
    externalEventId: string,
  ): Promise<ProvenanceRow | null> {
    return (await this.prisma.requisitionExternalTransitionProvenance.findUnique({
      where: {
        tenant_id_connection_id_external_event_id: {
          tenant_id: tenantId,
          connection_id: connectionId,
          external_event_id: externalEventId,
        },
      },
    })) as ProvenanceRow | null;
  }
}
