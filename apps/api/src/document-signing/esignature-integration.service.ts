import { Inject, Injectable } from '@nestjs/common';
import { AramoError, createAramoLogger } from '@aramo/common';
import {
  SIGNATURE_PROVIDERS,
  SignatureRoutingRepository,
  isSignatureProvider,
  type SignatureProviderKey,
} from '@aramo/signature-routing';

import { isExternalAdapter, type ExternalSignatureAdapter } from '../esignature-providers/external-signature-adapter.js';
import { newCodeVerifier } from '../esignature-providers/pkce.js';

import { SignatureAvailabilityService, type SignatureAvailability } from './signature-availability.service.js';
import { SIGNATURE_PROVIDER_REGISTRY, type SignatureProviderRegistry } from './signature-router.js';

// Multi-Provider directive §E — Settings → Integrations → E-Signature.
// One active provider per tenant (V1). A change is explicit, audited (append-only
// selection event + structured log) and backend-validated. A provider is only
// selectable when this build can actually send through it; an external provider
// is never presented as connected before its OAuth/API/webhook integration exists.

export type ESignatureProviderStatus = 'BUILT_IN' | 'CONNECTED' | 'NOT_CONNECTED' | 'NOT_AVAILABLE';

export interface ESignatureProviderRow {
  readonly provider: SignatureProviderKey;
  readonly status: ESignatureProviderStatus;
  readonly selectable: boolean;
  /** An admin can connect (or reconnect) this provider's account in this environment. */
  readonly connectable: boolean;
  /** The stored connection stopped working (e.g. a refresh token was revoked). */
  readonly needs_reconnect: boolean;
}

export interface ESignatureOverview {
  readonly active_provider: SignatureProviderKey;
  readonly providers: readonly ESignatureProviderRow[];
  /** The tenant-level availability of the active provider (allowance included for Aramo Sign). */
  readonly availability: SignatureAvailability;
  readonly recent_changes: readonly { from_provider: string; to_provider: string; actor_id: string; occurred_at: string }[];
}

const logger = createAramoLogger('ESignatureIntegrationService');

@Injectable()
export class ESignatureIntegrationService {
  constructor(
    private readonly routing: SignatureRoutingRepository,
    private readonly availability: SignatureAvailabilityService,
    @Inject(SIGNATURE_PROVIDER_REGISTRY) private readonly registry: SignatureProviderRegistry,
  ) {}

  private adapter(provider: SignatureProviderKey): ExternalSignatureAdapter | null {
    const port = this.registry.get(provider);
    return port !== undefined && isExternalAdapter(port) ? port : null;
  }

  private async row(tenant_id: string, provider: SignatureProviderKey): Promise<ESignatureProviderRow> {
    if (provider === 'aramo_sign') return { provider, status: 'BUILT_IN', selectable: true, connectable: false, needs_reconnect: false };
    // External adapters register only when this environment has the provider's app registration.
    const adapter = this.adapter(provider);
    if (adapter === null) return { provider, status: 'NOT_AVAILABLE', selectable: false, connectable: false, needs_reconnect: false };
    const state = await adapter.connectionState(tenant_id);
    return state === 'CONNECTED'
      ? { provider, status: 'CONNECTED', selectable: true, connectable: true, needs_reconnect: false }
      : { provider, status: 'NOT_CONNECTED', selectable: false, connectable: true, needs_reconnect: state === 'DEGRADED' };
  }

  private requireAdapter(provider: string, requestId: string): ExternalSignatureAdapter {
    const adapter = provider === 'docusign' || provider === 'adobe_sign' ? this.adapter(provider) : null;
    if (adapter === null) {
      throw new AramoError('VALIDATION_ERROR', 'This e-signature provider cannot be connected in this environment', 422, {
        requestId,
        details: { reason: 'PROVIDER_UNAVAILABLE', provider },
      });
    }
    return adapter;
  }

  /** Start connecting the tenant's provider account: returns the provider's sign-in URL. */
  async connect(tenant_id: string, provider: string, actor_id: string, requestId: string): Promise<{ authorize_url: string }> {
    const adapter = this.requireAdapter(provider, requestId);
    const code_verifier = newCodeVerifier();
    const { state } = await this.routing.createOAuthState({ tenant_id, user_id: actor_id, provider: adapter.provider, code_verifier, ttl_ms: 10 * 60 * 1000 });
    logger.log({ event: 'esignature.connect_started', tenant_id, actor_id, provider });
    return { authorize_url: adapter.authorizeUrl({ state, code_verifier }) };
  }

  /** The provider redirected back: the state must be this admin's, unused and unexpired. */
  async completeConnect(input: { tenant_id: string; provider: string; actor_id: string; code: string; state: string; params: Record<string, string>; requestId: string }): Promise<void> {
    const adapter = this.requireAdapter(input.provider, input.requestId);
    const consumed = await this.routing.consumeOAuthState({ state: input.state, tenant_id: input.tenant_id, user_id: input.actor_id, provider: adapter.provider });
    if (consumed === null) {
      throw new AramoError('VALIDATION_ERROR', 'This connect link has expired or was already used', 400, { requestId: input.requestId, details: { reason: 'OAUTH_STATE_INVALID' } });
    }
    await adapter.completeAuthorization({ tenant_id: input.tenant_id, code: input.code, code_verifier: consumed.code_verifier, callback_params: input.params });
    logger.log({ event: 'esignature.connected', tenant_id: input.tenant_id, actor_id: input.actor_id, provider: input.provider });
  }

  /**
   * Disconnect the provider account. The tenant's selection is NOT switched silently:
   * if this provider is active, sends read PROVIDER_DISCONNECTED until an admin
   * reconnects or selects another provider.
   */
  async disconnect(tenant_id: string, provider: string, actor_id: string, requestId: string): Promise<ESignatureOverview> {
    const adapter = this.requireAdapter(provider, requestId);
    await adapter.disconnect(tenant_id);
    logger.log({ event: 'esignature.disconnected', tenant_id, actor_id, provider });
    return this.overview(tenant_id);
  }

  async overview(tenant_id: string): Promise<ESignatureOverview> {
    const [{ provider }, availability, events] = await Promise.all([
      this.routing.getSelectedProvider(tenant_id),
      this.availability.evaluate(tenant_id),
      this.routing.listSelectionEvents(tenant_id),
    ]);
    return {
      active_provider: provider,
      providers: await Promise.all(SIGNATURE_PROVIDERS.map((p) => this.row(tenant_id, p))),
      availability,
      recent_changes: events
        .slice(-5)
        .reverse()
        .map((e) => ({ ...e, occurred_at: e.occurred_at.toISOString() })),
    };
  }

  async select(tenant_id: string, provider: SignatureProviderKey, actor_id: string, requestId: string): Promise<ESignatureOverview> {
    if (!isSignatureProvider(provider)) {
      throw new AramoError('VALIDATION_ERROR', 'provider must be one of aramo_sign, docusign, adobe_sign', 400, { requestId });
    }
    const row = await this.row(tenant_id, provider);
    if (!row.selectable) {
      throw new AramoError('VALIDATION_ERROR', 'This e-signature provider is not available to select yet', 422, {
        requestId,
        details: { reason: row.status === 'NOT_CONNECTED' ? 'PROVIDER_DISCONNECTED' : 'PROVIDER_UNAVAILABLE', provider },
      });
    }
    const change = await this.routing.selectProvider({ tenant_id, provider, actor_id });
    logger.log({ event: 'esignature.active_provider_set', tenant_id, actor_id, from: change.from, to: change.to, changed: change.changed });
    return this.overview(tenant_id);
  }
}
