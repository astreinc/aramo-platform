import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

// L2-I (D1) — the PIPELINE PROVIDER-DISPOSITION MAPPING seam (structurally analogous
// to RequisitionLifecycleMappingRepository, but a SEPARATE Pipeline-owned contract).
// Pure data-access: NO @aramo/pipeline import (SB-7 — the connector/integration lib
// never receives a Pipeline mutation surface). The canonical-target VOCABULARY
// (recruiter actions + non-system disposition reasons; never COMPLETE /
// DOWNSTREAM_OUTCOME) is validated at AUTHOR time in apps/api (which owns the pipeline
// vocabulary); this repo stores the already-validated bounded Strings.

/** The per-connection authority posture (bounded String; external default). */
export type PipelineProviderAuthorityMode = 'external_authority' | 'dual_control';

/** A resolved mapping entry from the connection's ACTIVE set for one provider token.
 * `disposition` = EXECUTE_ACTION | IGNORE; `mapped_target`/`target_kind` are null for
 * IGNORE. `mapping_version` is the ACTIVE set's version, carried into provenance. */
export interface PipelineDispositionMappingResolved {
  readonly disposition: string;
  readonly mapped_target: string | null;
  readonly target_kind: string | null;
  readonly mapping_version: number;
  readonly authority_mode: PipelineProviderAuthorityMode;
}

interface ActiveSetRef {
  id: string;
  version: number;
}

interface MappingRow {
  disposition: string;
  mapped_target: string | null;
  target_kind: string | null;
  authority_mode: PipelineProviderAuthorityMode;
}

// The nil actor stamped on a seed/compatibility-synthesized active set.
const MAPPING_SEED_SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class PipelineProviderDispositionMappingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolve the mapping for a provider token from the connection's ACTIVE set. No
   * active set OR no row for the token → null (UNMAPPABLE). */
  async findByConnectionState(
    tenantId: string,
    connectionId: string,
    providerToken: string,
  ): Promise<PipelineDispositionMappingResolved | null> {
    const activeSet = (await this.prisma.pipelineProviderDispositionMappingSet.findFirst({
      where: { tenant_id: tenantId, connection_id: connectionId, status: 'active' },
      select: { id: true, version: true },
    })) as ActiveSetRef | null;
    if (activeSet === null) return null;

    const row = (await this.prisma.pipelineProviderDispositionMapping.findUnique({
      where: {
        mapping_set_id_provider_token: {
          mapping_set_id: activeSet.id,
          provider_token: providerToken,
        },
      },
      select: { disposition: true, mapped_target: true, target_kind: true, authority_mode: true },
    })) as MappingRow | null;
    return row === null
      ? null
      : {
          disposition: row.disposition,
          mapped_target: row.mapped_target,
          target_kind: row.target_kind,
          mapping_version: activeSet.version,
          authority_mode: row.authority_mode,
        };
  }

  /** Author (or seed) a runtime-resolvable mapping. Ensures an ACTIVE version-1 set
   * for the connection and upserts the row (keyed mapping_set_id + provider_token).
   * The CALLER (apps/api mapping-admin) has already validated `mapped_target` against
   * the canonical vocabulary; IGNORE nulls target+kind (honoring the DB CHECK). */
  async upsertMapping(args: {
    tenant_id: string;
    connection_id: string;
    provider_token: string;
    mapped_target?: string | null;
    target_kind?: string | null;
    disposition?: string;
    mapping_version?: number;
    authority_mode?: PipelineProviderAuthorityMode;
  }): Promise<void> {
    const authorityMode = args.authority_mode ?? 'external_authority';
    const disposition = args.disposition ?? 'EXECUTE_ACTION';
    const mappedTarget = disposition === 'IGNORE' ? null : args.mapped_target ?? null;
    const targetKind = disposition === 'IGNORE' ? null : args.target_kind ?? null;

    let active = (await this.prisma.pipelineProviderDispositionMappingSet.findFirst({
      where: { tenant_id: args.tenant_id, connection_id: args.connection_id, status: 'active' },
      select: { id: true, version: true },
    })) as ActiveSetRef | null;
    if (active === null) {
      active = (await this.prisma.pipelineProviderDispositionMappingSet.create({
        data: {
          tenant_id: args.tenant_id,
          connection_id: args.connection_id,
          version: args.mapping_version ?? 1,
          status: 'active',
          created_by: MAPPING_SEED_SYSTEM_ACTOR,
        },
        select: { id: true, version: true },
      })) as ActiveSetRef;
    }

    await this.prisma.pipelineProviderDispositionMapping.upsert({
      where: {
        mapping_set_id_provider_token: {
          mapping_set_id: active.id,
          provider_token: args.provider_token,
        },
      },
      create: {
        tenant_id: args.tenant_id,
        connection_id: args.connection_id,
        mapping_set_id: active.id,
        provider_token: args.provider_token,
        disposition,
        mapped_target: mappedTarget,
        target_kind: targetKind,
        mapping_version: active.version,
        authority_mode: authorityMode,
      },
      update: { disposition, mapped_target: mappedTarget, target_kind: targetKind, authority_mode: authorityMode },
    });
  }

  /** List all authored rows in the connection's ACTIVE set (admin read). Empty when no
   * active set. Ordered by provider_token for a stable admin view. */
  async listActiveMappings(
    tenantId: string,
    connectionId: string,
  ): Promise<ReadonlyArray<{ provider_token: string; disposition: string; mapped_target: string | null; target_kind: string | null }>> {
    const activeSet = (await this.prisma.pipelineProviderDispositionMappingSet.findFirst({
      where: { tenant_id: tenantId, connection_id: connectionId, status: 'active' },
      select: { id: true },
    })) as { id: string } | null;
    if (activeSet === null) return [];
    return (await this.prisma.pipelineProviderDispositionMapping.findMany({
      where: { mapping_set_id: activeSet.id },
      select: { provider_token: true, disposition: true, mapped_target: true, target_kind: true },
      orderBy: { provider_token: 'asc' },
    })) as Array<{ provider_token: string; disposition: string; mapped_target: string | null; target_kind: string | null }>;
  }

  /** OUTBOUND — the reverse mapping: given a canonical Pipeline target (action or reason),
   * return the provider token(s) the connection's ACTIVE set maps to it. Used to render a
   * canonical Pipeline event back into a provider's vocabulary (outbound path). Never renames
   * the Aramo event; it only looks up the connection's authored provider label. */
  async findProviderTokensForTarget(
    tenantId: string,
    connectionId: string,
    mappedTarget: string,
  ): Promise<readonly string[]> {
    const activeSet = (await this.prisma.pipelineProviderDispositionMappingSet.findFirst({
      where: { tenant_id: tenantId, connection_id: connectionId, status: 'active' },
      select: { id: true },
    })) as { id: string } | null;
    if (activeSet === null) return [];
    const rows = (await this.prisma.pipelineProviderDispositionMapping.findMany({
      where: { mapping_set_id: activeSet.id, mapped_target: mappedTarget, disposition: 'EXECUTE_ACTION' },
      select: { provider_token: true },
      orderBy: { provider_token: 'asc' },
    })) as Array<{ provider_token: string }>;
    return rows.map((r) => r.provider_token);
  }
}

/** A resolved external→Aramo episode identity. */
export interface ExternalPipelineEpisodeResolved {
  readonly pipeline_id: string;
  readonly external_episode_id: string;
}

// ExternalPipelineEpisodeIdentityRepository — connection-scoped external episode
// identity + per-event idempotency. UUID ref to pipeline.Pipeline (NO FK, I15).
@Injectable()
export class ExternalPipelineEpisodeIdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolve the Aramo pipeline episode a provider's external episode id binds to
   * (connection-scoped). null → no identity established yet. */
  async resolveByExternalEpisode(
    tenantId: string,
    connectionId: string,
    externalEpisodeId: string,
  ): Promise<ExternalPipelineEpisodeResolved | null> {
    const row = (await this.prisma.externalPipelineEpisodeIdentity.findUnique({
      where: {
        tenant_id_connection_id_external_episode_id: {
          tenant_id: tenantId,
          connection_id: connectionId,
          external_episode_id: externalEpisodeId,
        },
      },
      select: { pipeline_id: true, external_episode_id: true },
    })) as ExternalPipelineEpisodeResolved | null;
    return row;
  }

  /** Record a connection-scoped identity, idempotent on the establishing event.
   * A redelivered event resolves to the existing row (no duplicate). */
  async recordIdentity(args: {
    tenant_id: string;
    connection_id: string;
    external_episode_id: string;
    pipeline_id: string;
    external_event_id: string;
  }): Promise<void> {
    await this.prisma.externalPipelineEpisodeIdentity.upsert({
      where: {
        tenant_id_connection_id_external_event_id: {
          tenant_id: args.tenant_id,
          connection_id: args.connection_id,
          external_event_id: args.external_event_id,
        },
      },
      create: {
        tenant_id: args.tenant_id,
        connection_id: args.connection_id,
        external_episode_id: args.external_episode_id,
        pipeline_id: args.pipeline_id,
        external_event_id: args.external_event_id,
      },
      update: {},
    });
  }
}

/** One pending reconciliation row (D1 writes 'pending' only; never mutates Pipeline). */
export interface PipelineReconciliationInput {
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly external_event_id: string;
  readonly external_episode_id: string;
  readonly provider_token: string;
  readonly mapped_target?: string | null;
  readonly current_pipeline_status?: string | null;
  readonly failure_reason: string;
}

interface PipelineReconciliationRow {
  id: string;
  failure_reason: string;
  status: string;
  mapped_target: string | null;
  current_pipeline_status: string | null;
}

// PipelineExternalReconciliationRepository — the record-then-resolve PENDING queue.
@Injectable()
export class PipelineExternalReconciliationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Record a pending row, idempotent on the external event (a replay converges). */
  async recordPending(input: PipelineReconciliationInput): Promise<PipelineReconciliationRow> {
    return (await this.prisma.pipelineExternalReconciliation.upsert({
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
        external_episode_id: input.external_episode_id,
        provider_token: input.provider_token,
        mapped_target: input.mapped_target ?? null,
        current_pipeline_status: input.current_pipeline_status ?? null,
        failure_reason: input.failure_reason,
        status: 'pending',
      },
      update: {},
      select: { id: true, failure_reason: true, status: true, mapped_target: true, current_pipeline_status: true },
    })) as PipelineReconciliationRow;
  }

  async findByExternalEvent(tenantId: string, connectionId: string, externalEventId: string): Promise<PipelineReconciliationRow | null> {
    return (await this.prisma.pipelineExternalReconciliation.findUnique({
      where: { tenant_id_connection_id_external_event_id: { tenant_id: tenantId, connection_id: connectionId, external_event_id: externalEventId } },
      select: { id: true, failure_reason: true, status: true, mapped_target: true, current_pipeline_status: true },
    })) as PipelineReconciliationRow | null;
  }
}

/** One immutable external-transition provenance record (on a governed EXECUTE). */
export interface PipelineProvenanceInput {
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly external_event_id: string;
  readonly external_episode_id: string;
  readonly pipeline_id: string;
  readonly mapping_version: number;
  readonly mapped_target: string;
  readonly target_kind: string;
  readonly aramo_expected_version: number;
  readonly provider_sequence?: bigint | number | null;
}

interface PipelineProvenanceRow {
  id: string;
  mapping_version: number;
  mapped_target: string;
  aramo_expected_version: number;
  provider_sequence: bigint | null;
}

// PipelineExternalTransitionProvenanceRepository — append-only provenance (AC-4). Records
// the Aramo expected_version used (CAS token) SEPARATELY from the provider sequence.
@Injectable()
export class PipelineExternalTransitionProvenanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: PipelineProvenanceInput): Promise<PipelineProvenanceRow> {
    return (await this.prisma.pipelineExternalTransitionProvenance.create({
      data: {
        tenant_id: input.tenant_id,
        connection_id: input.connection_id,
        external_event_id: input.external_event_id,
        external_episode_id: input.external_episode_id,
        pipeline_id: input.pipeline_id,
        mapping_version: input.mapping_version,
        mapped_target: input.mapped_target,
        target_kind: input.target_kind,
        aramo_expected_version: input.aramo_expected_version,
        provider_sequence: input.provider_sequence === undefined || input.provider_sequence === null ? null : BigInt(input.provider_sequence),
      },
      select: { id: true, mapping_version: true, mapped_target: true, aramo_expected_version: true, provider_sequence: true },
    })) as PipelineProvenanceRow;
  }

  async findByExternalEvent(tenantId: string, connectionId: string, externalEventId: string): Promise<PipelineProvenanceRow | null> {
    return (await this.prisma.pipelineExternalTransitionProvenance.findUnique({
      where: { tenant_id_connection_id_external_event_id: { tenant_id: tenantId, connection_id: connectionId, external_event_id: externalEventId } },
      select: { id: true, mapping_version: true, mapped_target: true, aramo_expected_version: true, provider_sequence: true },
    })) as PipelineProvenanceRow | null;
  }
}
