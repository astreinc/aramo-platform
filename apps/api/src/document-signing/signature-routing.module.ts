import { Module } from '@nestjs/common';
import type { SignatureProviderPort } from '@aramo/documents-contracts';
import { EntitlementModule } from '@aramo/entitlement';
import { SignatureRoutingStoreModule, type SignatureProviderKey } from '@aramo/signature-routing';
import { SubscriptionModule } from '@aramo/subscription';

import { EsignServiceApiProvider, assertSignAtsTransport } from '../sign/esign-service-api.provider.js';
import { SignApiClient } from '../sign/sign-api.client.js';
import type { ExternalSignatureAdapter } from '../esignature-providers/external-signature-adapter.js';
import { ExternalSignatureProvidersModule } from '../esignature-providers/external-signature-providers.module.js';
import { EXTERNAL_SIGNATURE_ADAPTERS } from '../esignature-providers/provider-completion.service.js';

import { SignatureAvailabilityService } from './signature-availability.service.js';
import { SIGNATURE_PROVIDER_REGISTRY } from './signature-router.js';
import { SignatureRoutingService } from './signature-routing.service.js';

// Multi-Provider directive §D/§E/§F — the digital-signature availability and
// routing capability, composed once and imported by every signing workflow
// (RTR, Offer, client-submittal policy authoring, the availability read).
//
// The registry lists the providers this build can actually reach. Aramo Sign is
// the native sign-service over the authenticated Sign API; the DocuSign and Adobe
// Acrobat Sign adapters register here when they land (PR 4/5). A selected
// provider missing from the registry reads PROVIDER_UNAVAILABLE.
@Module({
  imports: [EntitlementModule, SubscriptionModule, SignatureRoutingStoreModule, ExternalSignatureProvidersModule],
  providers: [
    // Addendum S6 — the authenticated Sign API transport, the only one (Domain
    // Isolation V1 §3 H-2 retired the unauthenticated internal path).
    SignApiClient,
    EsignServiceApiProvider,
    {
      provide: SIGNATURE_PROVIDER_REGISTRY,
      useFactory: (
        api: EsignServiceApiProvider,
        external: readonly ExternalSignatureAdapter[],
      ): ReadonlyMap<SignatureProviderKey, SignatureProviderPort> => {
        assertSignAtsTransport();
        return new Map<SignatureProviderKey, SignatureProviderPort>([['aramo_sign', api], ...external.map((a) => [a.provider, a] as const)]);
      },
      inject: [EsignServiceApiProvider, EXTERNAL_SIGNATURE_ADAPTERS],
    },
    SignatureAvailabilityService,
    SignatureRoutingService,
  ],
  exports: [SignatureAvailabilityService, SignatureRoutingService, SignatureRoutingStoreModule, SIGNATURE_PROVIDER_REGISTRY, ExternalSignatureProvidersModule, SignApiClient],
})
export class SignatureRoutingModule {}
