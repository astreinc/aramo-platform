import { Injectable } from '@nestjs/common';
import {
  CommunicationsRepository,
  type ProviderIdentityBindingRow,
} from '@aramo/communications';
import type {
  ProviderIdentityBinding,
  ProviderIdentityStatus,
  ProviderIdentityStorePort,
  UpsertProviderIdentityArgs,
} from '@aramo/microsoft-graph';

// COMM-C2B — recruiter↔provider identity binding over the existing
// CommunicationProviderIdentity SoR (R6/R7/R11; no new binding table). Wraps the
// communications repository (where the Prisma type is intact); all reads/writes
// are tenant-scoped. `provider_tenant_id` holds the provider's own tenant id
// (Microsoft `tid`); the port exposes it neutrally as `ms_tenant_id`.
@Injectable()
export class ProviderIdentityStoreAdapter implements ProviderIdentityStorePort {
  constructor(private readonly repo: CommunicationsRepository) {}

  private toBinding(row: ProviderIdentityBindingRow): ProviderIdentityBinding {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      integration_connection_id: row.integration_connection_id,
      recruiter_id: row.recruiter_id,
      provider_user_id: row.provider_user_id,
      ms_tenant_id: row.provider_tenant_id ?? '',
      status: row.status as ProviderIdentityStatus,
      email_enabled: row.email_enabled,
    };
  }

  async upsert(args: UpsertProviderIdentityArgs): Promise<ProviderIdentityBinding> {
    const row = await this.repo.upsertProviderIdentityBinding({
      tenant_id: args.tenant_id,
      integration_connection_id: args.integration_connection_id,
      recruiter_id: args.recruiter_id,
      provider_user_id: args.provider_user_id,
      provider_tenant_id: args.ms_tenant_id,
      email_enabled: args.email_enabled,
    });
    return this.toBinding(row);
  }

  async findByRecruiter(
    tenantId: string,
    connectionId: string,
    recruiterId: string,
  ): Promise<ProviderIdentityBinding | null> {
    const row = await this.repo.findProviderIdentityBindingForRecruiter(
      tenantId,
      connectionId,
      recruiterId,
    );
    return row === null ? null : this.toBinding(row);
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: ProviderIdentityStatus,
  ): Promise<ProviderIdentityBinding> {
    const row = await this.repo.setProviderIdentityStatus(tenantId, id, status);
    if (row === null) {
      throw new Error('provider identity not found for tenant');
    }
    return this.toBinding(row);
  }

  async countByStatus(
    tenantId: string,
    connectionId: string,
  ): Promise<Record<ProviderIdentityStatus, number>> {
    const rows = await this.repo.countProviderIdentitiesByStatus(tenantId, connectionId);
    const acc: Record<ProviderIdentityStatus, number> = {
      active: 0,
      unmapped: 0,
      disabled: 0,
      reauth_required: 0,
    };
    for (const r of rows) {
      acc[r.status as ProviderIdentityStatus] += r.count;
    }
    return acc;
  }
}
