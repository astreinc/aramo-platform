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
  LEGAL_DOCUMENT_TITLES,
  PERSONAL_LEGAL_DOCUMENT_KEYS,
  approvedLegalDocument,
  legalRef,
  type LegalDocumentKey,
  type LegalDocumentVersion,
} from './lib/legal/legal-documents.js';
export { LegalAcceptanceService, inAppContextRef } from './lib/legal/legal-acceptance.service.js';
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
// CCP-A2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A2) — the commercial audit
// stream, the versioned commercial policy (fail-closed parser) and its pure boundary checks.
export {
  COMMERCIAL_POLICY_FORMAT_VERSION,
  COMMERCIAL_POLICY_KEYS,
  CommercialPolicyUnavailableError,
  canonicalJson,
  commercialPolicyChecksum,
  parseActiveCommercialPolicy,
  parseCommercialPolicyContent,
  type CommercialPolicy,
  type CommercialPolicyContent,
  type CommercialPolicyUnavailableReason,
  type CommercialPolicyVersionRecord,
} from './lib/commercial/commercial-policy.js';
export {
  CommercialPolicyInputError,
  approvalExpiresAt,
  checkSupportExtension,
  creditEscalation,
  discountEscalates,
  isApprovalExpired,
  isWithinPastDueGrace,
  pastDueGraceUntil,
  type AppliedSupportExtension,
  type CreditEscalation,
  type SupportExtensionBreach,
  type SupportExtensionCheck,
} from './lib/commercial/commercial-policy-boundaries.js';
export {
  CommercialPolicyRepository,
  type CommercialPolicyActor,
  type CommercialPolicyStatus,
  type CommercialPolicyVersionRow,
} from './lib/commercial/commercial-policy.repository.js';
export {
  COMMERCIAL_AUDIT_DEFAULT_LIMIT,
  COMMERCIAL_AUDIT_EVENT_TYPE_PATTERN,
  COMMERCIAL_AUDIT_MAX_LIMIT,
  CommercialAuditCursorError,
  CommercialAuditRepository,
  type AppendCommercialAuditEventInput,
  type CommercialAuditEventRow,
  type CommercialAuditPage,
  type CommercialAuditQuery,
} from './lib/commercial/commercial-audit.repository.js';
