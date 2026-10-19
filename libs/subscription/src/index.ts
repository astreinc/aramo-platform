export { SubscriptionModule } from './lib/subscription.module.js';
export {
  AllowanceService,
  thresholdOf,
  type AllowanceReadResult,
  type AllowanceStatus,
  type AllowanceThreshold,
  type AllowanceUnavailableReason,
  type ReserveResult,
  type UnsubscribedState,
  subscriptionSends,
} from './lib/allowance.service.js';
// Aramo Sign launch — subscription lifecycle + billing provider.
export {
  BILLING_PROVIDER_PORT,
  BillingProviderUnavailableError,
  BillingWebhookSignatureError,
  type BillingProviderPort,
  type CheckoutSessionRequest,
  type ProviderSubscriptionState,
  type VerifiedBillingEvent,
} from './lib/billing/billing-provider.port.js';
export { StripeBillingProvider, STRIPE_API_VERSION, stripeEventSubscriptionRef, stripeSubscriptionState, verifyStripeSignature } from './lib/billing/stripe-billing.provider.js';
export {
  SubscriptionLifecycleService,
  BillingRefusedError,
  PAST_DUE_GRACE_DAYS_DEFAULT,
  mapProviderStatus,
  parsePlanPrices,
  type AccountView,
  type ApplyResult,
  type BillingRefusal,
  type SellablePlanView,
  type SubscriptionView,
  type WebhookResult,
} from './lib/billing/subscription-lifecycle.service.js';
export { addMonthsClamped, billingPeriodAt, type BillingPeriod } from './lib/billing-period.js';
export { AramoSignBusinessPlanKey, AramoSignIncludedPlanKey, assertNotProduction, openDevelopmentSubscription } from './lib/development-subscription.js';
export { PrismaService as SubscriptionPrismaService } from './lib/prisma/prisma.service.js';

/** The Aramo Sign envelope allowance and the usage-stream event it writes. */
export const ESIGN_ENVELOPE_ALLOWANCE = 'esign.envelopes';
export const ESIGN_ENVELOPE_SENT_EVENT = 'esign.envelope.sent';
