import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

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
