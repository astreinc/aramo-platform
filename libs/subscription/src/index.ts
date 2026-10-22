export { SubscriptionModule } from './lib/subscription.module.js';
export {
  AllowanceService,
  thresholdOf,
  type AllowanceReadResult,
  type AllowanceStatus,
  type AllowanceThreshold,
  type AllowanceUnavailableReason,
  type AllowanceWindowStatus,
  DAY_WINDOW_MS,
  type ReserveResult,
  type UnsubscribedState,
  subscriptionSends,
} from './lib/allowance.service.js';
// Aramo Sign launch — subscription lifecycle + billing provider.
export {
  BILLING_PROVIDER_PORT,
  type BillingAccountDetails,
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
  BILLING_COUNTRY_NOT_SUPPORTED,
  DOMAIN_NOT_AUTHORITATIVE,
  billingCountrySupported,
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
// Sign Signup Amendment A1 (Organization Details, US only) §2.6 — the organization billing profile port.
export {
  ORGANIZATION_BILLING_PROFILE_PORT,
  type OrganizationBillingAddress,
  type OrganizationBillingProfile,
  type OrganizationBillingProfilePort,
  type OrganizationProfileRefusal,
} from './lib/billing/organization-billing-profile.port.js';
// Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED §4 — the FREE subscription.
export {
  FreePersonalSubscriptionService,
  FreePersonalPlanKey,
  FREE_SUBSCRIPTION_SOURCE,
  personalSignupMode,
  type EnsureFreeResult,
  type FreeSubscriptionRefusal,
  type PersonalSignupMode,
} from './lib/free-personal-subscription.js';
