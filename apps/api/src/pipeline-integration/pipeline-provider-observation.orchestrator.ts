import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { PipelineRepository, type RecruiterPipelineAction } from '@aramo/pipeline';
import {
  PipelineProviderDispositionMappingRepository,
  ExternalPipelineEpisodeIdentityRepository,
  PipelineExternalReconciliationRepository,
  PipelineExternalTransitionProvenanceRepository,
} from '@aramo/integration';

import { resolveReasonAuthority } from './pipeline-provider-mapping-target.js';

// L2-I (D1) — the inbound PIPELINE provider-observation reconciler-analog (apps/api
// composition root; the ONLY layer permitted to hold both the integration mapping seam AND
// the governed @aramo/pipeline command — SB-7). Mirrors the ADR-0030 requisition reconciler:
//   resolve connection-scoped episode identity → resolve mapping from the ACTIVE set →
//   (unmappable / no-lineage / dual-control / illegal-from-state → record PENDING, NEVER mutate)
//   OR (external_authority EXECUTE_ACTION → governed Pipeline command → provenance).
// The command's expected_version is ALWAYS the Aramo episode version (CAS); the provider
// sequence is recorded for audit but NEVER used as expected_version (AC-4). This file is the
// ONLY status-writing path from a provider observation.

// A fixed system principal for connector-driven governed commands (audit-stable, not a user).
export const CONNECTOR_PIPELINE_SYSTEM_ACTOR_ID = '01900000-0000-7000-8000-0000000000c1';

export const PIPELINE_RECONCILE_REASON = {
  NO_EPISODE_LINEAGE: 'NO_EPISODE_LINEAGE',
  PROVIDER_TOKEN_UNMAPPABLE: 'PROVIDER_TOKEN_UNMAPPABLE',
  ILLEGAL_FROM_STATE: 'ILLEGAL_FROM_STATE',
  DUAL_CONTROL_PENDING: 'DUAL_CONTROL_PENDING',
} as const;

export type PipelineObservationOutcome =
  | 'executed'
  | 'ignored'
  | 'pending_no_lineage'
  | 'pending_unmappable'
  | 'pending_illegal'
  | 'pending_dual_control';

export interface PipelineProviderObservation {
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly external_episode_id: string;
  readonly external_event_id: string;
  readonly provider_token: string;
  // Provider ordering — recorded for audit, NEVER the Pipeline CAS token.
  readonly provider_sequence?: number | bigint | null;
  readonly requestId: string;
}

@Injectable()
export class PipelineProviderObservationOrchestrator {
  constructor(
    private readonly pipeline: PipelineRepository,
    private readonly mappings: PipelineProviderDispositionMappingRepository,
    private readonly identities: ExternalPipelineEpisodeIdentityRepository,
    private readonly reconciliations: PipelineExternalReconciliationRepository,
    private readonly provenance: PipelineExternalTransitionProvenanceRepository,
  ) {}

  async ingest(obs: PipelineProviderObservation): Promise<PipelineObservationOutcome> {
    const base = {
      tenant_id: obs.tenant_id,
      connection_id: obs.connection_id,
      external_event_id: obs.external_event_id,
      external_episode_id: obs.external_episode_id,
      provider_token: obs.provider_token,
    };

    // 1 — resolve the Aramo episode from connection-scoped identity. No identity → pending.
    const identity = await this.identities.resolveByExternalEpisode(obs.tenant_id, obs.connection_id, obs.external_episode_id);
    if (identity === null) {
      await this.reconciliations.recordPending({ ...base, failure_reason: PIPELINE_RECONCILE_REASON.NO_EPISODE_LINEAGE });
      return 'pending_no_lineage';
    }

    // 2 — resolve the mapping from the ACTIVE set. Unmappable → pending (never mutate).
    const mapping = await this.mappings.findByConnectionState(obs.tenant_id, obs.connection_id, obs.provider_token);
    if (mapping === null) {
      await this.reconciliations.recordPending({ ...base, failure_reason: PIPELINE_RECONCILE_REASON.PROVIDER_TOKEN_UNMAPPABLE });
      return 'pending_unmappable';
    }

    // 3 — IGNORE is a deliberate, audited no-op (no mutation, no pending).
    if (mapping.disposition === 'IGNORE') return 'ignored';

    // 4 — dual_control records intent; it does NOT auto-execute the governed command.
    if (mapping.authority_mode === 'dual_control') {
      await this.reconciliations.recordPending({ ...base, mapped_target: mapping.mapped_target, failure_reason: PIPELINE_RECONCILE_REASON.DUAL_CONTROL_PENDING });
      return 'pending_dual_control';
    }

    // 5 — external_authority EXECUTE_ACTION → the governed Pipeline command.
    const episode = await this.pipeline.findById({ tenant_id: obs.tenant_id, id: identity.pipeline_id });
    if (episode === null) {
      await this.reconciliations.recordPending({ ...base, mapped_target: mapping.mapped_target, failure_reason: PIPELINE_RECONCILE_REASON.NO_EPISODE_LINEAGE });
      return 'pending_no_lineage';
    }

    // The CAS token is ALWAYS the Aramo episode version — NEVER obs.provider_sequence.
    const expected_version = episode.version;
    const isReason = mapping.target_kind === 'reason';
    const action: RecruiterPipelineAction = isReason ? 'DISPOSITION' : (mapping.mapped_target as RecruiterPipelineAction);
    const reason = isReason ? (mapping.mapped_target ?? undefined) : undefined;
    // The DISPOSITION command requires the reason's authority class (RECRUITER/TALENT/
    // ENGAGEMENT) — resolved from the pipeline vocabulary here (apps/api).
    const authority_class = isReason && reason !== undefined ? resolveReasonAuthority(reason) : null;

    try {
      await this.pipeline.applyAction({
        tenant_id: obs.tenant_id,
        id: identity.pipeline_id,
        action,
        expected_version,
        changed_by_id: CONNECTOR_PIPELINE_SYSTEM_ACTOR_ID,
        requestId: obs.requestId,
        visible_requisition_ids: null,
        ...(reason === undefined ? {} : { reason }),
        ...(authority_class === null ? {} : { authority_class }),
      });
    } catch (err) {
      // Illegal-from-state / invalid reason → pending (NEVER a partial mutation).
      const code = err instanceof AramoError ? err.code : undefined;
      if (code === 'INVALID_PIPELINE_TRANSITION' || code === 'PIPELINE_DISPOSITION_REASON_INVALID') {
        await this.reconciliations.recordPending({
          ...base,
          mapped_target: mapping.mapped_target,
          current_pipeline_status: episode.status,
          failure_reason: PIPELINE_RECONCILE_REASON.ILLEGAL_FROM_STATE,
        });
        return 'pending_illegal';
      }
      throw err; // a CAS conflict / infra error is not a D1 pending class — surface it
    }

    // EXECUTED — record provenance with the mapping_version + the Aramo CAS token used,
    // keeping provider_sequence a SEPARATE audit field (AC-4).
    await this.provenance.record({
      tenant_id: obs.tenant_id,
      connection_id: obs.connection_id,
      external_event_id: obs.external_event_id,
      external_episode_id: obs.external_episode_id,
      pipeline_id: identity.pipeline_id,
      mapping_version: mapping.mapping_version,
      mapped_target: mapping.mapped_target as string,
      target_kind: mapping.target_kind as string,
      aramo_expected_version: expected_version,
      provider_sequence: obs.provider_sequence ?? null,
    });
    return 'executed';
  }
}
