export { SubscriptionModule } from './lib/subscription.module.js';
// CCP-A4 (MP-A2 N-6, N-10, N-11) — the closed product registry and the explicit product context.
export {
  BASE_COMPOSITION,
  PRODUCT_KEYS,
  ProductContextError,
  PRODUCT_CAPABILITIES,
  SIGN_PRODUCT_KEY,
  assertProductKey,
  isProductKey,
  productOfMeteredKey,
  type CompositionRole,
  type ProductKey,
} from './lib/product-registry.js';
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
// CCP-A3 (PBD §5.1 row A3) — change request, approval, eligibility; the D9 attestation store.
export {
  A6_APPLICABLE_ACTIONS,
  COMMERCIAL_A3_TRANSITIONS,
  COMMERCIAL_TRANSITIONS,
  COMMERCIAL_ACTIONS,
  COMMERCIAL_ACTION_TYPES,
  COMMERCIAL_CHANGE_REQUEST_KINDS,
  COMMERCIAL_CHANGE_REQUEST_STATES,
  COMMERCIAL_OPEN_STATES,
  COMMERCIAL_A6_APPLY_TRANSITIONS,
  COMMERCIAL_A9_ROLE_APPLY_TRANSITIONS,
  COMMERCIAL_REQUEST_PRODUCT_KEYS,
  COMMERCIAL_ROLE_CHANGE_ACTIONS,
  COMMERCIAL_ROLE_CHANGE_ROLE_KEYS,
  COMMERCIAL_TERMINAL_STATES,
  CommercialChangeRequestIntegrityError,
  CommercialPayloadError,
  canTransition,
  canTransitionFor,
  isA6Applicable,
  parseRequiredChain,
  payloadChecksum,
  resolveRequiredChain,
  subjectUserOf,
  validatePayload,
  type A6ApplicableAction,
  type CommercialActionDefinition,
  type CommercialActionType,
  type CommercialChainRule,
  type CommercialChainStep,
  type CommercialChangeRequestKind,
  type CommercialChangeRequestState,
  type CommercialDomain,
  type CommercialRequiredChain,
} from './lib/commercial/commercial-change-request.js';
export {
  APPROVAL_REFUSALS,
  CommercialApplyRefusedError,
  actorSatisfiesStep,
  assertChainStillSatisfiableAtApply,
  checkApprovalEligibility,
  checkChainSatisfiable,
  type ApplyCheckRequest,
  type ApplyRefusalReason,
  type ApprovalRefusal,
  type ChainSatisfiability,
  type EligibilityActor,
  type EligibilityApproval,
  type EligibilityRequest,
  type EligibilityResult,
  type RosterEntry,
} from './lib/commercial/commercial-approval-eligibility.js';
export {
  CommercialOperatorRepository,
  D9_STATEMENT_VERSION,
  type CommercialOperatorAttestationRow,
  type LiveOperator,
} from './lib/commercial/commercial-operator.repository.js';
export {
  COMMERCIAL_CLOCK,
  CommercialApprovalRefusedError,
  CommercialChangeRequestCursorError,
  CommercialChangeRequestError,
  CommercialChangeRequestService,
  CommercialNotBootstrappedError,
  type ChangeRequestView,
  type CommercialActor,
  type CommercialApprovalRow,
  type CommercialCallContext,
  type CommercialChangeRequestErrorCode,
  type CommercialChangeRequestRow,
  type CommercialClock,
  type CreateChangeRequestInput,
  type ListChangeRequestsQuery,
  type RoleChangeApplyOutcome,
  type StepView,
} from './lib/commercial/commercial-change-request.service.js';
// CCP-A6 (PBD §5.1 row A6; Conversion Rule C-21…C-24) — the transactional apply and the shared
// billing lock / governed-subscription predicate.
export {
  COMMERCIAL_APPLY_FAULT_HOOK,
  CommercialApplyFailedError,
  CommercialApplyService,
  type CommercialApplyFailureCode,
  type CommercialApplyFaultHook,
  type CommercialApplyFaultPoint,
  type CommercialApplyResult,
  type CommercialChangeApplicationRow,
} from './lib/commercial/commercial-apply.service.js';
// CCP-B4 (PBD §5.3 row B4; MP-A2 N-3) — enterprise contract records (written only by the A6
// apply; state, plan and commitment read through TenantSubscription) and their read model.
export {
  CONTRACT_MAX_DOCUMENTS,
  CONTRACT_MAX_TERMS,
  CONTRACT_PAYLOAD_KEYS,
  CONTRACT_REF_PATTERN,
  changeCarriesContract,
  validateContractBlocks,
  type ContractAmendmentBlock,
  type ContractEndBlock,
  type ContractEvidenceDocument,
  type ContractRecordBlock,
} from './lib/commercial/commercial-contract.js';
export {
  CONTRACT_LIST_DEFAULT_LIMIT,
  CONTRACT_LIST_MAX_LIMIT,
  ContractRepository,
  type ContractAmendmentView,
  type ContractDetailView,
  type ContractDocumentView,
  type ContractPerson,
  type ContractStatus,
  type ContractSummaryView,
} from './lib/commercial/commercial-contract.repository.js';
export { GOVERNED_SUBSCRIPTION_OPEN, billingLockKey, isGovernedSubscription, takeBillingLock } from './lib/billing/governed-subscription.js';
export { C16_QUERY_A, checkoutCutoverReport, formatCheckoutCutoverReport, type CheckoutCutoverReport } from './lib/billing/checkout-cutover-check.js';
// CCP-A5 (PBD §5.1 row A5; MP-A2 N-15…N-19; Charter D3) — plan versions, the provider price
// pinned to the version, and the read-only cutover parity check. Publishing and retiring are
// repository methods applied by CCP-A6 from approved change requests.
export {
  PIN_REASON_CHANGE_REQUEST,
  PIN_REASON_PROVIDER_PLAN_CHANGE,
  PLAN_VERSION_CONTENT_FORMAT,
  PLAN_VERSION_STATUSES,
  PlanVersionContentError,
  parsePlanVersionContent,
  planVersionChecksum,
  planVersionContentFromRows,
  planVersionTerms,
  type LivePlanRows,
  type PlanVersionAllowance,
  type PlanVersionAllowanceWindow,
  type PlanVersionCapacity,
  type PlanVersionContent,
  type PlanVersionFeature,
  type PlanVersionPlanTerms,
  type PlanVersionStatus,
} from './lib/plan-version.js';
export { PlanVersionRepository, PlanVersionStateError, currentPublishedVersion, type PlanVersionRow } from './lib/plan-version.repository.js';
export {
  BILLING_PRICE_PROVIDER,
  checkProviderPriceParity,
  effectiveProviderPrice,
  resolvePriceToVersion,
  type BillingPriceProvider,
  type EffectivePrice,
  type PriceParityEntry,
  type PriceParityReport,
  type PriceParityStatus,
  type PriceResolution,
} from './lib/billing/provider-price.js';
// CCP-A9 (PBD §5.1 row A9) — governed role change (identity writes), the last-owner marker
// and the one-time D7 platform-owner bootstrap command.
export {
  PLATFORM_LAST_OWNER_DB_MARKER,
  PLATFORM_OWNER_ROLE_KEY,
  RoleChangeApplyError,
  effectivePlatformOwners,
  isPlatformLastOwnerViolation,
  readPlatformSubject,
  type PlatformSubjectFacts,
  type RoleChangeApplyReason,
} from './lib/commercial/commercial-role-change.js';
export {
  BOOTSTRAP_CLI_FLAGS,
  BOOTSTRAP_PLATFORM_TENANT_ID,
  BOOTSTRAP_TARGET_EMAIL,
  PLATFORM_OWNER_BOOTSTRAP_EVENT,
  PlatformOwnerBootstrapRefusedError,
  parseBootstrapArgs,
  runPlatformOwnerBootstrap,
  type PlatformOwnerBootstrapInput,
  type PlatformOwnerBootstrapRefusal,
  type PlatformOwnerBootstrapResult,
} from './lib/commercial/commercial-platform-owner-bootstrap.js';
