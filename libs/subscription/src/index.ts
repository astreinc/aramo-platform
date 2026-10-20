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
  type CatalogPlanView,
  STORAGE_CAPACITY_KEY,
  postTerminationExportDays,
  type SubscriptionView,
  type WebhookResult,
} from './lib/billing/subscription-lifecycle.service.js';
export { addMonthsClamped, billingPeriodAt, type BillingPeriod } from './lib/billing-period.js';
export { AramoSignStandardBusinessPlanKey, AramoSignStandardProfessionalPlanKey, AramoSignIncludedPlanKey, assertNotProduction, openDevelopmentSubscription } from './lib/development-subscription.js';
export { PrismaService as SubscriptionPrismaService } from './lib/prisma/prisma.service.js';

/** The Aramo Sign envelope allowance and the usage-stream event it writes. */
export const ESIGN_ENVELOPE_ALLOWANCE = 'sign.envelopes';
export const ESIGN_ENVELOPE_SENT_EVENT = 'sign.envelope.sent';
// Commercial Plans Amendment A1 — capacity (storage), eligibility, legal registry.
export { CapacityService, type CapacityStatus, type CapacityRefusal, type CapacityReserveResult } from './lib/capacity.service.js';
export { PLAN_ELIGIBILITY_PORT, type PlanEligibilityPort, type PlanEligibilityRule } from './lib/billing/plan-eligibility.port.js';
export {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_REGISTRY,
  approvedLegalDocument,
  legalRef,
  type LegalDocumentKey,
  type LegalDocumentVersion,
} from './lib/legal/legal-documents.js';
export { LegalAcceptanceService } from './lib/legal/legal-acceptance.service.js';
export { FEATURE_AVAILABILITY, isFeatureAvailable, type FeatureAvailability } from './lib/feature-availability.js';
