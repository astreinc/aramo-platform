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
  BILLING_PROVIDER_COMMAND_PORT,
  BILLING_PROVIDER_PORT,
  type BillingAccountDetails,
  type BillingProviderCommandPort,
  type ProviderCheckoutSessionState,
  BillingProviderUnavailableError,
  BillingWebhookSignatureError,
  type BillingProviderPort,
  type CheckoutSessionRequest,
  type ProviderSubscriptionState,
  type VerifiedBillingEvent,
} from './lib/billing/billing-provider.port.js';
export {
  StripeBillingProvider,
  STRIPE_API_VERSION,
  stripeCheckoutSessionState,
  stripeEventCheckoutSessionRef,
  stripeEventSubscriptionRef,
  stripeSubscriptionState,
  verifyStripeSignature,
} from './lib/billing/stripe-billing.provider.js';
// CCP-C3 — the read-only provider port, its GET-only Stripe adapter and the read-through status service.
export {
  BILLING_PROVIDER_READ_PORT,
  type BillingProviderReadPort,
  type ProviderInvoiceState,
  type ProviderPortalConfigurationState,
} from './lib/billing/billing-provider.port.js';
export { STRIPE_READ_ADAPTER_METHODS, StripeBillingReadAdapter } from './lib/billing/stripe-billing-read.adapter.js';
export {
  BILLING_STATUS_AVAILABILITY,
  BILLING_STATUS_DEFAULT_INVOICE_LIMIT,
  BILLING_STATUS_MAX_INVOICE_LIMIT,
  BillingStatusQueryError,
  BillingStatusReadService,
  INVOICE_PAYMENT_STATES,
  PORTAL_CONFIGURATION_STATES,
  invoicePaymentState,
  type BillingPortalConfigurationStatus,
  type BillingStatusAvailability,
  type BillingStatusInvoice,
  type InvoicePaymentState,
  type PortalConfigurationState,
  type TenantBillingStatus,
} from './lib/billing/billing-status-read.service.js';
// CCP-C1 — the Stripe command outbox and the webhook inbox.
export {
  BILLING_COMMAND_ACTIONS,
  BILLING_COMMAND_KINDS,
  BILLING_COMMAND_MAX_ATTEMPTS,
  BILLING_COMMAND_STATES,
  BILLING_COMMAND_TRANSITIONS,
  BILLING_COMMAND_UNCONFIRMED_STATES,
  SUBSCRIPTION_CANCEL_MODES,
  billingCommandIdempotencyKey,
  canTransitionBillingCommand,
  type BillingCommandConfirmation,
  type BillingCommandKind,
  type BillingCommandState,
  type SubscriptionCancelMode,
} from './lib/billing/billing-provider-command.js';
export {
  BillingCommandError,
  BillingCommandService,
  type BillingCommandErrorCode,
  type BillingCommandListQuery,
  type BillingCommandRow,
  type DispatchTally,
  type EnqueueBillingCommandInput,
  type ReconcileTally,
} from './lib/billing/billing-command.service.js';
export {
  BILLING_WEBHOOK_INBOX_STATUSES,
  BillingWebhookInboxQueryError,
  BillingWebhookInboxService,
  INBOX_MAX_AUTOMATIC_ATTEMPTS,
  type BillingWebhookInboxRow,
  type BillingWebhookInboxStatus,
  type DrainTally,
} from './lib/billing/billing-webhook-inbox.service.js';
// CCP-B3 — the read-only Subscriptions workbench and tenant Commercial tab reads (no money).
export {
  CommercialSubscriptionReadService,
  OVERVIEW_PRODUCT_KEYS,
  type EntitlementState,
  type OverviewFlag,
  type OverviewOpenRequest,
  type OverviewProduct,
  type OverviewProductKey,
  type ProductEntitlement,
  type TenantCommercialOverview,
  type WorkbenchResult,
  type WorkbenchRow,
  type WorkbenchSubscription,
} from './lib/commercial/commercial-subscription-read.service.js';
// CCP-C6 — the read-only Finance reports (renewals, outstanding payments, reconciliation).
export {
  BillingFinanceReportService,
  FINANCE_CURRENCY,
  FINANCE_SOURCES,
  INVOICE_READ_NOT_DELIVERED,
  OUTSTANDING_STATUSES,
  RENEWAL_HORIZON_DEFAULT_DAYS,
  RENEWAL_HORIZON_MAX_DAYS,
  daysUntil,
  formatReconciliationReport,
  graceStateAt,
  priceFigure,
  type DiscrepancyCode,
  type EntitledWithoutSubscription,
  type FinanceFilter,
  type GraceState,
  type HeldActivation,
  type ListPrice,
  type OtherOpenFlag,
  type OutstandingItem,
  type OutstandingReport,
  type PriceFigure,
  type ReconciledSubscription,
  type ReconciliationReport,
  type RenewalItem,
  type RenewalKind,
  type RenewalsReport,
  type UnpricedReason,
} from './lib/billing/billing-finance-report.service.js';
// CCP-D2 — revenue reporting (MRR / ARR / renewal pipeline) derived from commercial records; no ledger.
export {
  ARR_MONTHS,
  BillingRevenueReportService,
  FINANCE_SCOPE_PENDING,
  REVENUE_BASIS,
  REVENUE_BEARING_STATUSES,
  REVENUE_BILLING_INTERVAL,
  REVENUE_EXCLUSION_REASONS,
  REVENUE_PIPELINE_DEFAULT_MONTHS,
  REVENUE_PIPELINE_MAX_MONTHS,
  classifyRevenueRow,
  computeRevenue,
  formatRevenueReport,
  monthKey,
  type RenewalBucket,
  type RevenueExclusion,
  type RevenueExclusionReason,
  type RevenueLine,
  type RevenueOptions,
  type RevenueProductLine,
  type RevenueReport,
  type RevenueSourceRow,
} from './lib/billing/billing-revenue-report.service.js';
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
  TENANT_ACTIVATION_PENDING_MESSAGE,
  type TenantActivationState,
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
  B2_CATALOG_APPLY_ACTIONS,
  isCatalogApplicable,
  COMMERCIAL_A3_TRANSITIONS,
  COMMERCIAL_TRANSITIONS,
  COMMERCIAL_ACTIONS,
  COMMERCIAL_ACTION_TYPES,
  COMMERCIAL_CHANGE_REQUEST_KINDS,
  COMMERCIAL_CHANGE_REQUEST_STATES,
  COMMERCIAL_OPEN_STATES,
  COMMERCIAL_A6_APPLY_TRANSITIONS,
  COMMERCIAL_A9_ROLE_APPLY_TRANSITIONS,
  COMMERCIAL_C2_CONVERSION_TRANSITIONS,
  COMMERCIAL_B5R_POLICY_APPLY_TRANSITIONS,
  APPLY_EXPIRABLE_ACTIONS,
  isApplyExpirable,
  COMMERCIAL_REQUEST_PRODUCT_KEYS,
  COMMERCIAL_ROLE_CHANGE_ACTIONS,
  COMMERCIAL_ROLE_CHANGE_ROLE_KEYS,
  COMMERCIAL_TERMINAL_STATES,
  POLICY_TARGET_CHECKSUM_KEY,
  CommercialChangeRequestIntegrityError,
  CommercialPayloadError,
  canTransition,
  canTransitionFor,
  isA6Applicable,
  APPLY_SERVICE_ACTIONS,
  COMMERCIAL_A8_EXCEPTION_TRANSITIONS,
  boundedExceptionChain,
  isApplyServiceAction,
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
  type BoundedExceptionEvidence,
  type CommercialApplyResult,
  type CommercialChangeApplicationRow,
} from './lib/commercial/commercial-apply.service.js';
// CCP-A6-R — the shared apply refusal / failure records (stable codes + operator explanations).
export { APPLY_EXPLANATIONS, explanationOf } from './lib/commercial/commercial-apply-records.js';
// CCP-B2-backend — the governed catalog publish / retire apply.
export {
  COMMERCIAL_CATALOG_APPLY_FAULT_HOOK,
  CommercialCatalogApplyService,
  type CommercialCatalogApplicationRow,
  type CommercialCatalogApplyFaultHook,
  type CommercialCatalogApplyResult,
} from './lib/commercial/commercial-catalog-apply.service.js';
// CCP-B5-R (TD-B5-1) — the governed POLICY_ACTIVATE apply (requester-only; APPROVED → APPLYING → APPLIED).
export {
  COMMERCIAL_POLICY_APPLY_FAULT_HOOK,
  CommercialPolicyApplyService,
  POLICY_APPLY_FAILURE_CODES,
  type CommercialPolicyApplyFaultHook,
  type CommercialPolicyApplyResult,
} from './lib/commercial/commercial-policy-apply.service.js';
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
// CCP-C2 (PBD §5.2 row C2; Conversion Rule C-11…C-15, C-29) — governed manual ↔ self-service conversion.
export {
  CONVERSION_DIRECTIONS,
  CONVERSION_RELEASE_STATES,
  CONVERSION_RELEASE_TRANSITIONS,
  ConversionApplyFailedError,
  ConversionApplyRefusedError,
  conversionPayloadErrors,
  effectiveReleaseState,
  type ConversionDirection,
  type ConversionFailureCode,
  type ConversionPayload,
  type ConversionRefusalCode,
  type ConversionReleaseState,
} from './lib/commercial/commercial-conversion.js';
export { CommercialConversionLedger, type ConversionReleaseRow } from './lib/commercial/commercial-conversion.ledger.js';
export { CommercialConversionService, type ConversionApplyResult, type ConversionStatus, type ConversionView } from './lib/commercial/commercial-conversion.service.js';
// CCP-A8 (PBD §5.1 row A8; DDR v1.2 §3.2(5)) — the support exception overlay.
export {
  SUPPORT_EXTENSION_SCOPE,
  SupportExtensionService,
  type RequestSupportExtensionInput,
  type SupportExtensionContext,
  type SupportExtensionOutcome,
  type SupportExtensionOverview,
  type SupportExtensionRow,
  type SupportExtensionSubscriptionRow,
} from './lib/commercial/support-extension.service.js';
export {
  decideSupportExtension,
  overlayCovers,
  supportExtensionWindow,
  type SupportExtensionDecision,
  type SupportExtensionEligibilityReason,
  type SupportExtensionOutcomeBreach,
} from './lib/commercial/support-extension.js';
export { C16_QUERY_A, checkoutCutoverReport, formatCheckoutCutoverReport, type CheckoutCutoverReport } from './lib/billing/checkout-cutover-check.js';
// CCP-B5 (PBD §5.3 row B5; TD-A9-16) — the POLICY_ACTIVATE apply (NC-5 snapshot re-check),
// policy drafts, the read-only audit export and the operator roster with chain state.
export {
  POLICY_LOCK_SQL,
  PolicyActivationRefusedError,
  activatePolicyVersionInTx,
  type PolicyActivationRefusalReason,
  type PolicyActivationResult,
  type PolicyActivationSnapshot,
} from './lib/commercial/commercial-policy-activation.js';
export {
  CommercialPolicyGovernanceService,
  POLICY_AUTHOR_ROLES,
  POLICY_EDITABLE_KEYS,
  POLICY_EDIT_RANGES,
  policyRangeErrors,
  type PolicyListView,
  type PolicyVersionView,
} from './lib/commercial/commercial-policy-governance.service.js';
export {
  COMMERCIAL_AUDIT_EXPORT_COLUMNS,
  COMMERCIAL_AUDIT_EXPORT_MAX_ROWS,
  CommercialAuditExportService,
  CommercialAuditExportTooLargeError,
  buildAuditCsv,
  csvField,
  type AuditExportNames,
  type CommercialAuditExportQuery,
  type CommercialAuditExportResult,
} from './lib/commercial/commercial-audit-export.service.js';
export {
  COMMERCIAL_CHAIN_PANEL,
  CommercialOperatorRosterService,
  chainFulfillability,
  type ChainFulfillability,
  type CommercialChainKey,
  type CommercialRosterView,
  type RosterOperatorView,
} from './lib/commercial/commercial-operator-roster.service.js';
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
export { PlanVersionDraftExistsError, PlanVersionRepository, PlanVersionStateError, currentPublishedVersion, type PlanVersionRow } from './lib/plan-version.repository.js';
// CCP-B2 (PBD §5.3 row B2) — the product and plan catalog read, and the DRAFT-only catalog writes
// (publish and retire are change requests applied by CCP-A6).
export {
  CATALOG_ENVELOPE_ALLOWANCE_KEY,
  CATALOG_STORAGE_CAPACITY_KEY,
  CATALOG_V1_BILLING_INTERVAL,
  CATALOG_V1_CURRENCY,
  CatalogDraftEditError,
  applyCatalogDraftEdits,
  catalogTermsOf,
  isContractPriced,
  type CatalogConflictReason,
  type CatalogDraftEdits,
  type CatalogVersionTerms,
} from './lib/commercial/commercial-catalog.js';
export {
  CATALOG_ACTION_TYPES,
  CATALOG_DRAFT_SCOPE,
  CommercialCatalogError,
  CommercialCatalogService,
  type CatalogActionType,
  type CatalogChainPreview,
  type CatalogOpenRequest,
  type CatalogPinnedTenant,
  type CatalogPlanView as CommercialCatalogPlanView,
  type CatalogProductView,
  type CatalogVersionDetail,
  type CatalogVersionSummary,
  type CatalogView,
  type CommercialCatalogErrorCode,
  type CreateDraftInput as CatalogCreateDraftInput,
  type UpdateDraftInput as CatalogUpdateDraftInput,
} from './lib/commercial/commercial-catalog.service.js';
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
// CCP-D1 (PBD §5.4 row D1) — the usage metric registry, the watermark roll-up worker, the
// reconciliation check and the read side (read-only until reconciled; no pricing).
export {
  USAGE_METRICS,
  USAGE_METRIC_SOURCES,
  usageMetricOf,
  usageMetricsOf,
  type UsageMetricDefinition,
  type UsageMetricSource,
} from './lib/usage/usage-metrics.js';
export {
  USAGE_PERIODS_DEFAULT_LIMIT,
  USAGE_PERIODS_MAX_LIMIT,
  USAGE_RECONCILIATION_MISMATCH_LIMIT,
  USAGE_ROLLUP_LOCK_KEY,
  UsageRollupService,
  type UsageCounts,
  type UsageMetricReconciliation,
  type UsageMetricRunResult,
  type UsageMismatch,
  type UsagePeriodRow,
  type UsagePeriodsQuery,
  type UsagePeriodsResult,
  type UsageReconciliation,
  type UsageReconciliationStatus,
  type UsageRollupMode,
  type UsageRollupRunOptions,
  type UsageRollupRunResult,
} from './lib/usage/usage-rollup.service.js';
// CCP-D3 — observability: the operational alert register (exception management), the alert
// scanner and the billing / approval counts-and-states metrics.
export {
  CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES_DEFAULT,
  CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES_DEFAULT,
  CCP_ALERT_RAISED_EVENT,
  CCP_ALERT_RESOLVED_EVENT,
  CCP_ALERT_SCAN_EVENT,
  CCP_ALERT_THRESHOLD_MAX_MINUTES,
  COMMERCIAL_ALERT_DEFINITIONS,
  COMMERCIAL_ALERT_FAMILIES,
  COMMERCIAL_ALERT_STATUSES,
  COMMERCIAL_ALERT_TYPES,
  commercialAlertThresholds,
  commercialAlertTypesOf,
  diffAlerts,
  type CommercialAlertFamily,
  type CommercialAlertStatus,
  type CommercialAlertThresholds,
  type CommercialAlertType,
  type DetectedCondition,
} from './lib/observability/commercial-alert.js';
export {
  COMMERCIAL_ALERT_SCAN_LOCK,
  COMMERCIAL_ALERT_SOURCE_CAP,
  CommercialAlertQueryError,
  CommercialAlertService,
  type ApprovalOperationsMetrics,
  type BillingOperationsMetrics,
  type CommercialAlertListQuery,
  type CommercialAlertRow,
  type CommercialAlertScanTally,
  type CommercialAlertSourceState,
} from './lib/observability/commercial-alert.service.js';
