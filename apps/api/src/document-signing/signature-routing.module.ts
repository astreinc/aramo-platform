import { Module } from '@nestjs/common';
import type { SignatureProviderPort } from '@aramo/documents-contracts';
import { EntitlementModule } from '@aramo/entitlement';
import { SignatureRoutingStoreModule, type SignatureProviderKey } from '@aramo/signature-routing';
import { SubscriptionModule } from '@aramo/subscription';

import { EsignServiceHttpProvider } from '../esign/esign-service-http.provider.js';

import { SignatureAvailabilityService } from './signature-availability.service.js';
import { SIGNATURE_PROVIDER_REGISTRY } from './signature-router.js';
import { SignatureRoutingService } from './signature-routing.service.js';

// Multi-Provider directive §D/§E/§F — the digital-signature availability and
// routing capability, composed once and imported by every signing workflow
// (RTR, Offer, client-submittal policy authoring, the availability read).
//
// The registry lists the providers this build can actually reach. Aramo Sign is
// the native esign-service over the existing HTTP seam; the DocuSign and Adobe
// Acrobat Sign adapters register here when they land (PR 4/5). A selected
// provider missing from the registry reads PROVIDER_UNAVAILABLE.
@Module({
  imports: [EntitlementModule, SubscriptionModule, SignatureRoutingStoreModule],
  providers: [
    EsignServiceHttpProvider,
    {
      provide: SIGNATURE_PROVIDER_REGISTRY,
      useFactory: (aramoSign: EsignServiceHttpProvider): ReadonlyMap<SignatureProviderKey, SignatureProviderPort> =>
        new Map<SignatureProviderKey, SignatureProviderPort>([['aramo_sign', aramoSign]]),
      inject: [EsignServiceHttpProvider],
    },
    SignatureAvailabilityService,
    SignatureRoutingService,
  ],
  exports: [SignatureAvailabilityService, SignatureRoutingService],
})
export class SignatureRoutingModule {}
