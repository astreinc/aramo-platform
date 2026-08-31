import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  PipelineProviderDispositionMappingRepository,
  IntegrationConnectionRepository,
  type PipelineProviderAuthorityMode,
} from '@aramo/integration';

import { resolveCanonicalMappingTargetKind } from './pipeline-provider-mapping-target.js';

// L2-I (D1) — the Pipeline provider-disposition mapping ADMIN seam (apps/api composition
// root — the ONLY layer that may know both @aramo/integration storage and the @aramo/pipeline
// canonical vocabulary; SB-7). Author-time validation happens HERE: an EXECUTE_ACTION mapping
// whose target is not in the canonical provider-mappable set is rejected
// (PIPELINE_PROVIDER_MAPPING_TARGET_INVALID 422) BEFORE any row is written; the target_kind is
// derived + stored so the inbound reconciler routes to the named-action command vs a
// DISPOSITION-with-reason. IGNORE is a deliberate no-op (target nulled).
@Injectable()
export class PipelineProviderMappingAdminService {
  constructor(
    private readonly mappings: PipelineProviderDispositionMappingRepository,
    private readonly connections: IntegrationConnectionRepository,
  ) {}

  // A cross-tenant / unknown connection is concealed as NOT_FOUND (404) — the mapping is
  // authored ONLY under a connection the tenant owns (mirrors the requisition mapping-admin).
  private async requireConnection(tenantId: string, connectionId: string, requestId: string): Promise<void> {
    const conn = await this.connections.findByIdForTenant(tenantId, connectionId);
    if (conn === null) {
      throw new AramoError('NOT_FOUND', 'Integration connection not found in tenant', 404, { requestId });
    }
  }

  async listMappings(args: { tenant_id: string; connection_id: string; requestId: string }) {
    await this.requireConnection(args.tenant_id, args.connection_id, args.requestId);
    return this.mappings.listActiveMappings(args.tenant_id, args.connection_id);
  }

  async authorMapping(args: {
    tenant_id: string;
    connection_id: string;
    provider_token: string;
    disposition?: 'EXECUTE_ACTION' | 'IGNORE';
    mapped_target?: string | null;
    authority_mode?: PipelineProviderAuthorityMode;
    requestId: string;
  }): Promise<void> {
    await this.requireConnection(args.tenant_id, args.connection_id, args.requestId);
    const disposition = args.disposition ?? 'EXECUTE_ACTION';
    if (disposition === 'IGNORE') {
      await this.mappings.upsertMapping({
        tenant_id: args.tenant_id,
        connection_id: args.connection_id,
        provider_token: args.provider_token,
        disposition: 'IGNORE',
        mapped_target: null,
        target_kind: null,
        authority_mode: args.authority_mode,
      });
      return;
    }

    // EXECUTE_ACTION — the target MUST be canonical (author-time rejection).
    const target = args.mapped_target ?? '';
    const target_kind = resolveCanonicalMappingTargetKind(target, args.requestId);
    await this.mappings.upsertMapping({
      tenant_id: args.tenant_id,
      connection_id: args.connection_id,
      provider_token: args.provider_token,
      disposition: 'EXECUTE_ACTION',
      mapped_target: target,
      target_kind,
      authority_mode: args.authority_mode,
    });
  }
}
