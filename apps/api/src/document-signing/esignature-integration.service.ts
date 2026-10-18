import { Inject, Injectable } from '@nestjs/common';
import { AramoError, createAramoLogger } from '@aramo/common';
import {
  SIGNATURE_PROVIDERS,
  SignatureRoutingRepository,
  isSignatureProvider,
  type SignatureProviderKey,
} from '@aramo/signature-routing';

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

  private row(provider: SignatureProviderKey): ESignatureProviderRow {
    if (provider === 'aramo_sign') return { provider, status: 'BUILT_IN', selectable: true };
    // External adapters register in the routing module once their integration exists.
    if (!this.registry.has(provider)) return { provider, status: 'NOT_AVAILABLE', selectable: false };
    return { provider, status: 'NOT_CONNECTED', selectable: false };
  }

  async overview(tenant_id: string): Promise<ESignatureOverview> {
    const [{ provider }, availability, events] = await Promise.all([
      this.routing.getSelectedProvider(tenant_id),
      this.availability.evaluate(tenant_id),
      this.routing.listSelectionEvents(tenant_id),
    ]);
    return {
      active_provider: provider,
      providers: SIGNATURE_PROVIDERS.map((p) => this.row(p)),
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
    const row = this.row(provider);
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
