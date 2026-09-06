import { Inject, Injectable } from '@nestjs/common';
import {
  DelegatedAuthorizationService,
  MICROSOFT_CAPABILITIES,
  PROVIDER_IDENTITY_STORE,
  decryptMicrosoftOAuthState,
  type AuthorizationResultView,
  type ProviderIdentityStatus,
  type ProviderIdentityStorePort,
  type StartAuthorizationResult,
} from '@aramo/microsoft-graph';

import { MicrosoftConfigResolver } from './microsoft-config.resolver.js';

export interface RecruiterBindingStatusView {
  readonly connection_id: string;
  readonly bound: boolean;
  readonly status: ProviderIdentityStatus | 'unmapped';
  readonly needs_reauthorization: boolean;
}

export interface ConnectionMappingStatusView {
  readonly connection_id: string;
  readonly provider_key: string;
  readonly capabilities: { readonly email: boolean; readonly meeting: boolean };
  readonly identities: Record<ProviderIdentityStatus, number>;
}

export type MicrosoftConfigurationState = 'NOT_CONFIGURED' | 'CONFIGURED' | 'REQUIRES_ATTENTION';

// PART B (B5) — tenant provider configuration + recruiter authorization are
// DIFFERENT states. A configured provider with zero recruiter bindings is not the
// same as an unconfigured one, so the status carries both the configuration_state
// and the recruiter identity counts, and never throws when unconfigured.
export interface MicrosoftProviderStatusView {
  readonly configuration_state: MicrosoftConfigurationState;
  readonly connection_id: string | null;
  readonly provider_key: string;
  readonly capabilities: { readonly email: boolean; readonly meeting: boolean };
  readonly identities: Record<ProviderIdentityStatus, number>;
}

const ZERO_IDENTITY_COUNTS: Record<ProviderIdentityStatus, number> = {
  active: 0,
  disabled: 0,
  reauth_required: 0,
  unmapped: 0,
};

// COMM-C2B composition root — drives the provider-neutral delegated
// authorization service using the resolved tenant connection config + the
// confidential-client secret (R3). No token is ever returned to the browser.
@Injectable()
export class MicrosoftAuthorizationOrchestrator {
  constructor(
    private readonly delegated: DelegatedAuthorizationService,
    private readonly config: MicrosoftConfigResolver,
    @Inject(PROVIDER_IDENTITY_STORE) private readonly identities: ProviderIdentityStorePort,
  ) {}

  /** C2B-7 — the signed-in recruiter's own binding status (for reauth UX). No token. */
  async getRecruiterBindingStatus(
    tenantId: string,
    recruiterId: string,
    connectionId?: string,
  ): Promise<RecruiterBindingStatusView> {
    const resolvedConnectionId = await this.config.resolveConnectionId(tenantId, connectionId);
    const binding = await this.identities.findByRecruiter(tenantId, resolvedConnectionId, recruiterId);
    if (binding === null) {
      return {
        connection_id: resolvedConnectionId,
        bound: false,
        status: 'unmapped',
        needs_reauthorization: true,
      };
    }
    return {
      connection_id: resolvedConnectionId,
      bound: binding.status === 'active',
      status: binding.status,
      needs_reauthorization: binding.status !== 'active',
    };
  }

  /** C2B-8 — tenant-admin provider mapping status + capabilities. No token. */
  async getConnectionMappingStatus(
    tenantId: string,
    connectionId?: string,
  ): Promise<ConnectionMappingStatusView> {
    const resolvedConnectionId = await this.config.resolveConnectionId(tenantId, connectionId);
    const identities = await this.identities.countByStatus(tenantId, resolvedConnectionId);
    return {
      connection_id: resolvedConnectionId,
      provider_key: 'microsoft_graph',
      capabilities: { email: MICROSOFT_CAPABILITIES.email, meeting: MICROSOFT_CAPABILITIES.meeting },
      identities,
    };
  }

  /**
   * PART B (B5) — tenant-admin provider status that NEVER throws when unconfigured.
   * Distinguishes NOT_CONFIGURED (no connection) from CONFIGURED (usable: config +
   * secret present) and REQUIRES_ATTENTION (connection exists but not usable, e.g.
   * secret missing or disabled). Recruiter authorization is a SEPARATE axis carried
   * in `identities`. Safe-disconnected: unconfigured returns a clean zero state.
   */
  async getProviderStatus(tenantId: string): Promise<MicrosoftProviderStatusView> {
    const capabilities = { email: MICROSOFT_CAPABILITIES.email, meeting: MICROSOFT_CAPABILITIES.meeting };
    const conn = await this.config.findConnection(tenantId);
    if (conn === null) {
      return {
        configuration_state: 'NOT_CONFIGURED',
        connection_id: null,
        provider_key: 'microsoft_graph',
        capabilities,
        identities: ZERO_IDENTITY_COUNTS,
      };
    }
    const identities = await this.identities.countByStatus(tenantId, conn.id);
    const usable = conn.has_secret && (conn.status === 'configured' || conn.status === 'active');
    return {
      configuration_state: usable ? 'CONFIGURED' : 'REQUIRES_ATTENTION',
      connection_id: conn.id,
      provider_key: 'microsoft_graph',
      capabilities,
      identities,
    };
  }

  /** PART B — tenant-admin create/update of the Microsoft connection (secret write-only). */
  async configureConnection(
    tenantId: string,
    input: { client_id: string; authority_tenant: string; client_secret?: string },
  ): Promise<MicrosoftProviderStatusView> {
    await this.config.configureConnection(tenantId, input);
    return this.getProviderStatus(tenantId);
  }

  /** C2B-3 authorize/start — returns the Microsoft authorize URL for the recruiter. */
  async start(
    tenantId: string,
    recruiterId: string,
    connectionId?: string,
  ): Promise<StartAuthorizationResult> {
    const resolvedConnectionId = await this.config.resolveConnectionId(tenantId, connectionId);
    const { clientId, authorityTenant } = await this.config.resolveConfig(
      tenantId,
      resolvedConnectionId,
      false,
    );
    return this.delegated.startAuthorization({
      tenant_id: tenantId,
      recruiter_id: recruiterId,
      connection_id: resolvedConnectionId,
      clientId,
      redirectUri: this.config.redirectUri(),
      authorityTenant,
      nowEpochSeconds: this.config.nowSeconds(),
    });
  }

  /** C2B-3 callback — validate state, exchange server-side, bind + custody. */
  async complete(code: string, encryptedState: string): Promise<AuthorizationResultView> {
    // Peek the state to resolve the connection's confidential-client secret; the
    // delegated service re-decrypts + enforces the TTL/integrity guard itself.
    const state = decryptMicrosoftOAuthState(encryptedState);
    const { clientId, clientSecret, authorityTenant } = await this.config.resolveConfig(
      state.tenant_id,
      state.connection_id,
      true,
    );
    return this.delegated.completeAuthorization({
      code,
      encryptedState,
      clientId,
      clientSecret,
      redirectUri: this.config.redirectUri(),
      authorityTenant,
      nowEpochSeconds: this.config.nowSeconds(),
    });
  }

  /** C2B-3 revoke/disconnect for the signed-in recruiter (R7). */
  async revoke(tenantId: string, recruiterId: string, connectionId?: string): Promise<void> {
    const resolvedConnectionId = await this.config.resolveConnectionId(tenantId, connectionId);
    await this.delegated.revoke(tenantId, resolvedConnectionId, recruiterId);
  }
}
