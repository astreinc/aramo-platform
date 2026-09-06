// COMM-C2B — recruiter↔Microsoft identity binding port (R6/R7). Backed by the
// existing CommunicationProviderIdentity table (no new binding table). Binds an
// Aramo (tenant, recruiter) to a Microsoft (tenant id, object id) under a
// provider connection. Status carries the reauthorization/disable lifecycle.

export const PROVIDER_IDENTITY_STORE = 'PROVIDER_IDENTITY_STORE';

export type ProviderIdentityStatus = 'active' | 'unmapped' | 'disabled' | 'reauth_required';

export interface ProviderIdentityBinding {
  readonly id: string;
  readonly tenant_id: string;
  readonly integration_connection_id: string;
  readonly recruiter_id: string;
  readonly provider_user_id: string; // Microsoft object id (oid)
  readonly ms_tenant_id: string;
  readonly status: ProviderIdentityStatus;
  readonly email_enabled: boolean;
}

export interface UpsertProviderIdentityArgs {
  readonly tenant_id: string;
  readonly integration_connection_id: string;
  readonly recruiter_id: string;
  readonly provider_user_id: string;
  readonly ms_tenant_id: string;
  readonly email_enabled: boolean;
}

export interface ProviderIdentityStorePort {
  /** Bind (or re-bind on reauthorization) a recruiter to a Microsoft identity. */
  upsert(args: UpsertProviderIdentityArgs): Promise<ProviderIdentityBinding>;
  findByRecruiter(
    tenantId: string,
    connectionId: string,
    recruiterId: string,
  ): Promise<ProviderIdentityBinding | null>;
  setStatus(
    tenantId: string,
    id: string,
    status: ProviderIdentityStatus,
  ): Promise<ProviderIdentityBinding>;
  countByStatus(tenantId: string, connectionId: string): Promise<Record<ProviderIdentityStatus, number>>;
}
