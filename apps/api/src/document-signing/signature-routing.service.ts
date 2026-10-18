import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { DEFAULT_SIGNATURE_PROVIDER, SignatureRoutingRepository, type SignatureProviderKey } from '@aramo/signature-routing';

import { SignatureAvailabilityService } from './signature-availability.service.js';
import {
  SIGNATURE_PROVIDER_REGISTRY,
  type RoutedSignatureProvider,
  type SignatureProviderRegistry,
  type SignatureRouter,
} from './signature-router.js';

// Multi-Provider directive §D/§E/§F — production routing. A refusal never falls
// back to another provider and never waives a required signature: the caller's
// workflow (e.g. a client-required RTR) simply stays blocked until it is signed.
@Injectable()
export class SignatureRoutingService implements SignatureRouter {
  constructor(
    private readonly availability: SignatureAvailabilityService,
    private readonly routing: SignatureRoutingRepository,
    @Inject(SIGNATURE_PROVIDER_REGISTRY) private readonly registry: SignatureProviderRegistry,
  ) {}

  private port(provider: SignatureProviderKey, requestId: string): RoutedSignatureProvider {
    const port = this.registry.get(provider);
    if (port === undefined) {
      throw new AramoError('ESIGN_SEND_UNAVAILABLE', 'The e-signature provider for this request is not available', 409, {
        requestId,
        details: { reason: 'PROVIDER_UNAVAILABLE', provider },
      });
    }
    return { provider, port };
  }

  async forNewSend(tenant_id: string, requestId: string): Promise<RoutedSignatureProvider> {
    const a = await this.availability.evaluate(tenant_id);
    if (!a.available || a.provider === null) {
      throw new AramoError('ESIGN_SEND_UNAVAILABLE', 'Sending for signature is not available right now', 409, {
        requestId,
        details: {
          reason: a.reason ?? 'NO_PROVIDER',
          provider: a.provider,
          ...(a.allowance !== null ? { allowance: a.allowance } : {}),
        },
      });
    }
    return this.port(a.provider, requestId);
  }

  async forDocument(tenant_id: string, document_id: string, document_revision_id: string): Promise<RoutedSignatureProvider> {
    const route = await this.routing.findRoute(tenant_id, document_id, document_revision_id);
    return this.port(route?.provider ?? DEFAULT_SIGNATURE_PROVIDER, '');
  }

  async recordRoute(input: Parameters<SignatureRouter['recordRoute']>[0]): Promise<void> {
    await this.routing.recordRoute(input);
  }
}
