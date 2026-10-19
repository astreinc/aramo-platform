import { Module } from '@nestjs/common';

import { AllowanceService } from './allowance.service.js';
import { BILLING_PROVIDER_PORT } from './billing/billing-provider.port.js';
import { StripeBillingProvider } from './billing/stripe-billing.provider.js';
import { SubscriptionLifecycleService } from './billing/subscription-lifecycle.service.js';
import { PrismaService } from './prisma/prisma.service.js';

// SubscriptionModule — the plan/subscription/allowance authority (Multi-Provider
// directive §B/§C). Kept apart from the signing engine and provider routing.
// Aramo Sign launch: the subscription lifecycle + the Stripe billing provider.
@Module({
  providers: [
    PrismaService,
    AllowanceService,
    { provide: BILLING_PROVIDER_PORT, useClass: StripeBillingProvider },
    SubscriptionLifecycleService,
  ],
  exports: [AllowanceService, SubscriptionLifecycleService, BILLING_PROVIDER_PORT],
})
export class SubscriptionModule {}
