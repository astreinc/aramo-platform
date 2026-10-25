import { type DynamicModule, Module, type ModuleMetadata, type Provider } from '@nestjs/common';

import { AllowanceService } from './allowance.service.js';
import { CapacityService } from './capacity.service.js';
import { CommercialAuditRepository } from './commercial/commercial-audit.repository.js';
import { CommercialPolicyRepository } from './commercial/commercial-policy.repository.js';
import { CommercialChangeRequestService } from './commercial/commercial-change-request.service.js';
import { CommercialOperatorRepository } from './commercial/commercial-operator.repository.js';
import { FreePersonalSubscriptionService } from './free-personal-subscription.js';
import { LegalAcceptanceService } from './legal/legal-acceptance.service.js';
import { PlanVersionRepository } from './plan-version.repository.js';
import { CommercialCatalogService } from './commercial/commercial-catalog.service.js';
import { BILLING_PROVIDER_PORT } from './billing/billing-provider.port.js';
import { StripeBillingProvider } from './billing/stripe-billing.provider.js';
import { SubscriptionLifecycleService } from './billing/subscription-lifecycle.service.js';
import { PrismaService } from './prisma/prisma.service.js';

// SubscriptionModule — the plan/subscription/allowance authority (Multi-Provider
// directive §B/§C). Kept apart from the signing engine and provider routing.
// Aramo Sign launch: the subscription lifecycle + the Stripe billing provider.
// CCP-A2: the commercial audit stream + the versioned commercial policy (read side).
// CCP-A3: change requests, approvals and the D9 operator attestation store.
// CCP-A5: the plan-version store (repository only; A6 applies publish / retire).
@Module({
  providers: [
    PrismaService,
    AllowanceService,
    CapacityService,
    LegalAcceptanceService,
    { provide: BILLING_PROVIDER_PORT, useClass: StripeBillingProvider },
    SubscriptionLifecycleService,
    FreePersonalSubscriptionService,
    CommercialAuditRepository,
    CommercialPolicyRepository,
    CommercialOperatorRepository,
    CommercialChangeRequestService,
    PlanVersionRepository,
    CommercialCatalogService,
  ],
  exports: [AllowanceService, CapacityService, LegalAcceptanceService, SubscriptionLifecycleService, FreePersonalSubscriptionService, BILLING_PROVIDER_PORT, CommercialAuditRepository, CommercialPolicyRepository, CommercialOperatorRepository, CommercialChangeRequestService, PlanVersionRepository, CommercialCatalogService],
})
export class SubscriptionModule {
  /**
   * A1 — the composing service binds the plan-eligibility port (e.g. the ATS
   * entitlement) inside this module's scope, where the lifecycle resolves it.
   */
  static forRoot(opts: { imports?: ModuleMetadata['imports']; providers?: Provider[] } = {}): DynamicModule {
    return {
      module: SubscriptionModule,
      imports: opts.imports ?? [],
      providers: [
        PrismaService,
        AllowanceService,
        CapacityService,
        LegalAcceptanceService,
        { provide: BILLING_PROVIDER_PORT, useClass: StripeBillingProvider },
        SubscriptionLifecycleService,
        FreePersonalSubscriptionService,
        CommercialAuditRepository,
        CommercialPolicyRepository,
        CommercialOperatorRepository,
        CommercialChangeRequestService,
        PlanVersionRepository,
        CommercialCatalogService,
        ...(opts.providers ?? []),
      ],
      exports: [AllowanceService, CapacityService, LegalAcceptanceService, SubscriptionLifecycleService, FreePersonalSubscriptionService, BILLING_PROVIDER_PORT, CommercialAuditRepository, CommercialPolicyRepository, CommercialOperatorRepository, CommercialChangeRequestService, PlanVersionRepository, CommercialCatalogService],
    };
  }
}
