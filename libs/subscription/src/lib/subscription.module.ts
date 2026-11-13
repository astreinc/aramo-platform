import { type DynamicModule, Module, type ModuleMetadata, type Provider } from '@nestjs/common';

import { AllowanceService } from './allowance.service.js';
import { CapacityService } from './capacity.service.js';
import { CommercialAuditRepository } from './commercial/commercial-audit.repository.js';
import { CommercialPolicyRepository } from './commercial/commercial-policy.repository.js';
import { CommercialChangeRequestService } from './commercial/commercial-change-request.service.js';
import { CommercialApplyService } from './commercial/commercial-apply.service.js';
// CCP-B2-backend — the governed catalog publish / retire apply.
import { CommercialCatalogApplyService } from './commercial/commercial-catalog-apply.service.js';
import { CommercialPolicyApplyService } from './commercial/commercial-policy-apply.service.js';
import { CommercialOperatorRepository } from './commercial/commercial-operator.repository.js';
import { CommercialAuditExportService } from './commercial/commercial-audit-export.service.js';
import { CommercialOperatorRosterService } from './commercial/commercial-operator-roster.service.js';
import { CommercialPolicyGovernanceService } from './commercial/commercial-policy-governance.service.js';
import { CommercialBillingAdjustmentLedger } from './commercial/commercial-billing-adjustment.ledger.js';
import { CommercialBillingAdjustmentService } from './commercial/commercial-billing-adjustment.service.js';
import { RefundRemainderGate } from './commercial/refund-remainder.gate.js';
import { CommercialRefundReportService } from './commercial/commercial-refund-report.service.js';
import { CommercialConversionLedger } from './commercial/commercial-conversion.ledger.js';
import { CommercialConversionService } from './commercial/commercial-conversion.service.js';
import { SupportExtensionService } from './commercial/support-extension.service.js';
import { FreePersonalSubscriptionService } from './free-personal-subscription.js';
import { LegalAcceptanceService } from './legal/legal-acceptance.service.js';
import { LegalChangeNoticeRepository } from './legal/legal-change-notice.repository.js';
import { RenewalNoticeRepository } from './billing/renewal-notice.js';
import { PlanVersionRepository } from './plan-version.repository.js';
import { CommercialCatalogService } from './commercial/commercial-catalog.service.js';
import { ContractRepository } from './commercial/commercial-contract.repository.js';
// CCP-C8-PR — the contract payment-status read (PR-10, PR-11).
import { ContractPaymentReadService } from './commercial/commercial-payment-record.js';
import { BILLING_PROVIDER_ADJUSTMENT_PORT, BILLING_PROVIDER_COMMAND_PORT, BILLING_PROVIDER_PORT, BILLING_PROVIDER_READ_PORT, BILLING_PROVIDER_SEAT_PORT } from './billing/billing-provider.port.js';
import { SeatBillingService } from './billing/seat-billing.service.js';
import { BillingStatusReadService } from './billing/billing-status-read.service.js';
import { StripeBillingReadAdapter } from './billing/stripe-billing-read.adapter.js';
import { BillingCommandService } from './billing/billing-command.service.js';
import { SelfServiceBillingService } from './billing/self-service-billing.service.js';
import { BillingWebhookInboxService } from './billing/billing-webhook-inbox.service.js';
import { BillingFinanceReportService } from './billing/billing-finance-report.service.js';
import { BillingRevenueReportService } from './billing/billing-revenue-report.service.js';
import { CommercialSubscriptionReadService } from './commercial/commercial-subscription-read.service.js';
import { StripeBillingProvider } from './billing/stripe-billing.provider.js';
import { SubscriptionLifecycleService } from './billing/subscription-lifecycle.service.js';
import { CommercialAlertService } from './observability/commercial-alert.service.js';
import { PrismaService } from './prisma/prisma.service.js';
// Sign Feature-Parity 1.1 — whether the Sign plan includes templates (P-6: Free never).
import { SignTemplateEntitlementService } from './sign-template-entitlement.service.js';
import { UsageRollupService } from './usage/usage-rollup.service.js';
// Sign Feature Parity D-2 (A1) — the metered usage ledger (UsageRecorder) and its provider reporting.
import { MeteredUsageService } from './usage/metered-usage.service.js';
import { USAGE_RECORDER } from './usage/usage-recorder.port.js';
import { UsageProviderReportService } from './usage/usage-provider-report.service.js';
import { UsagePeriodReconciliationService } from './usage/usage-period-reconciliation.service.js';
import { USAGE_METER_REPORT_PORT } from './billing/usage-meter.port.js';
// M-A12 W1-G — in-app store billing (App Store, Google Play): adapters behind ports, dark by default.
import { AppleAppStoreAdapter } from './billing/store/apple-app-store.adapter.js';
import { AppleJwsVerifier } from './billing/store/apple-jws.verifier.js';
import { GooglePlayAdapter } from './billing/store/google-play.adapter.js';
import { appleStoreConfig, googlePlayConfig } from './billing/store/store-billing.config.js';
import { APPLE_APP_STORE_PORT, GOOGLE_PLAY_PORT, STORE_SUBSCRIPTION_READER, StoreSubscriptionRegistry } from './billing/store/store-billing.port.js';
import { StoreBillingService } from './billing/store/store-billing.service.js';
import { AppleAscClient, appleAscConfig } from './billing/sync/apple-asc.client.js';
import { BillingProductsService } from './billing/sync/billing-products.service.js';
import { GooglePlayWriter } from './billing/sync/google-play.writer.js';
import { StripeCatalogWriter } from './billing/sync/stripe-catalog.writer.js';
// India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.1 — the billing region store.
import { BillingRegionService } from './billing/region/billing-region.service.js';
import { BILLING_GATEWAY_CONFIGURED, type BillingGatewayConfigured } from './billing/region/billing-region.view.js';
import type { BillingProviderPort } from './billing/billing-provider.port.js';

/** M-A12 — the store adapters (configured from env; unconfigured = that store off) and the re-fetch registry. */
const STORE_PROVIDERS: Provider[] = [
  { provide: APPLE_APP_STORE_PORT, useFactory: () => new AppleAppStoreAdapter(appleStoreConfig(), new AppleJwsVerifier()) },
  { provide: GOOGLE_PLAY_PORT, useFactory: () => new GooglePlayAdapter(googlePlayConfig()) },
  {
    provide: STORE_SUBSCRIPTION_READER,
    useFactory: (apple: AppleAppStoreAdapter, google: GooglePlayAdapter) => new StoreSubscriptionRegistry([apple, google]),
    inject: [APPLE_APP_STORE_PORT, GOOGLE_PLAY_PORT],
  },
  StoreBillingService,
  // CCP Billing Products Directive v1.0 (LOCKED) — the billing-products service and its three provider
  // clients (each dark until its credentials are set; the platform-admin worker is the only caller that
  // writes to a provider, and only with CCP_BILLING_SYNC_ENABLED=1).
  {
    provide: BillingProductsService,
    useFactory: (prisma: PrismaService, versions: PlanVersionRepository) =>
      new BillingProductsService(prisma, versions, [new StripeCatalogWriter(), new AppleAscClient(appleAscConfig()), new GooglePlayWriter(googlePlayConfig())]),
    inject: [PrismaService, PlanVersionRepository],
  },
];

/**
 * India Billing §4.1, G-2 — the billing region store and its gateway configured-check. Default binding:
 * STRIPE is configured when the bound Stripe billing port says so (no new reader of the Stripe key,
 * CCP-C5 C5-G-1). RAZORPAY is unconfigured here: the Razorpay gateway (WS-B) rebinds this token to the
 * gateway registry's configured(p).
 */
const REGION_PROVIDERS: Provider[] = [
  {
    provide: BILLING_GATEWAY_CONFIGURED,
    useFactory: (stripe: BillingProviderPort): BillingGatewayConfigured => (p) => (p === 'STRIPE' ? stripe.isConfigured() : false),
    inject: [BILLING_PROVIDER_PORT],
  },
  BillingRegionService,
];

// SubscriptionModule — the plan/subscription/allowance authority (Multi-Provider
// directive §B/§C). Kept apart from the signing engine and provider routing.
// Aramo Sign launch: the subscription lifecycle + the Stripe billing provider.
// CCP-A2: the commercial audit stream + the versioned commercial policy (read side).
// CCP-A3: change requests, approvals and the D9 operator attestation store.
// CCP-A5: the plan-version store (repository only; A6 applies publish / retire).
// CCP-A6: the transactional apply of approved Aramo-owned change requests.
// CCP-D1: usage roll-ups (derived, read-only until reconciled).
// CCP-B5: policy drafts, the audit export and the operator roster (read-only).
// CCP-C1: the Stripe command outbox (BillingCommandService, the command port bound to the same
// Stripe adapter) and the webhook inbox (BillingWebhookInboxService).
// CCP-C2: the governed conversion — the in-transaction ledger (bound into the lifecycle: releases,
// webhook-time conversion, confirmed-end completion) and the requester-only conversion apply.
// CCP-C3: the READ-ONLY provider port, bound to its own GET-only adapter (StripeBillingReadAdapter,
// never the write-capable StripeBillingProvider), and the read-through BillingStatusReadService.
// CCP-C6: the read-only Finance reports (BillingFinanceReportService).
// CCP-D2: revenue reporting derived from commercial records, no ledger (BillingRevenueReportService).
// CCP-A8: the support exception overlay (bounded EXCEPTION apply, escalation, overlay read).
// CCP-C7: tenant self-service visibility and the owner's cancel / upgrade (SelfServiceBillingService;
// the cancel is a CCP-C1 command; gated by APPROVED legal terms).
// CCP-C4: credits, discounts and refunds — the adjustment port bound to the same Stripe adapter, the
// in-transaction completion ledger (bound into the lifecycle) and the requester-only apply.
@Module({
  providers: [
    PrismaService,
    AllowanceService,
    CapacityService,
    SignTemplateEntitlementService,
    LegalAcceptanceService,
    // Privacy Notice 1.1 E-6 — legal-change notice delivery evidence.
    LegalChangeNoticeRepository,
    RenewalNoticeRepository,
    { provide: BILLING_PROVIDER_PORT, useClass: StripeBillingProvider },
    { provide: BILLING_PROVIDER_COMMAND_PORT, useClass: StripeBillingProvider },
    { provide: BILLING_PROVIDER_ADJUSTMENT_PORT, useClass: StripeBillingProvider },
    // Sign Business per-seat pricing — the provider seat quantity (same Stripe adapter) and the seat service.
    { provide: BILLING_PROVIDER_SEAT_PORT, useClass: StripeBillingProvider },
    SeatBillingService,
    { provide: BILLING_PROVIDER_READ_PORT, useClass: StripeBillingReadAdapter },
    BillingStatusReadService,
    SubscriptionLifecycleService,
    BillingCommandService,
    SelfServiceBillingService,
    BillingWebhookInboxService,
    BillingFinanceReportService,
    BillingRevenueReportService,
    CommercialSubscriptionReadService,
    FreePersonalSubscriptionService,
    CommercialAuditRepository,
    CommercialPolicyRepository,
    CommercialOperatorRepository,
    CommercialChangeRequestService,
    CommercialApplyService,
    CommercialCatalogApplyService,
    CommercialPolicyApplyService,
    CommercialPolicyGovernanceService,
    CommercialAuditExportService,
    CommercialOperatorRosterService,
    CommercialConversionLedger,
    CommercialConversionService,
    CommercialBillingAdjustmentLedger,
    CommercialBillingAdjustmentService,
    RefundRemainderGate,
    CommercialRefundReportService,
    SupportExtensionService,
    PlanVersionRepository,
    UsageRollupService,
    CommercialCatalogService,
    ContractRepository,
    ContractPaymentReadService,
    // CCP-D3 — the alert scanner, the exception register reads and the counts-and-states metrics.
    CommercialAlertService,
    MeteredUsageService,
    { provide: USAGE_RECORDER, useExisting: MeteredUsageService },
    { provide: USAGE_METER_REPORT_PORT, useClass: StripeBillingProvider },
    UsageProviderReportService,
    UsagePeriodReconciliationService,
    ...STORE_PROVIDERS,
    ...REGION_PROVIDERS,
  ],
  exports: [BillingRegionService, AllowanceService, CapacityService, SignTemplateEntitlementService, LegalAcceptanceService, LegalChangeNoticeRepository, RenewalNoticeRepository, SubscriptionLifecycleService, FreePersonalSubscriptionService, BILLING_PROVIDER_PORT, CommercialAuditRepository, CommercialPolicyRepository, CommercialOperatorRepository, CommercialChangeRequestService, CommercialApplyService, CommercialCatalogApplyService, CommercialPolicyApplyService, PlanVersionRepository, UsageRollupService, CommercialCatalogService, CommercialPolicyGovernanceService, CommercialAuditExportService, CommercialOperatorRosterService, ContractRepository, ContractPaymentReadService, BILLING_PROVIDER_COMMAND_PORT, BillingCommandService, BillingWebhookInboxService, CommercialConversionLedger, CommercialConversionService, BILLING_PROVIDER_READ_PORT, BillingStatusReadService, BillingFinanceReportService, BillingRevenueReportService, SupportExtensionService, CommercialAlertService, CommercialSubscriptionReadService, SelfServiceBillingService, CommercialBillingAdjustmentLedger, CommercialBillingAdjustmentService, RefundRemainderGate, CommercialRefundReportService, BILLING_PROVIDER_ADJUSTMENT_PORT, MeteredUsageService, USAGE_RECORDER, UsageProviderReportService, UsagePeriodReconciliationService, USAGE_METER_REPORT_PORT, StoreBillingService, BillingProductsService, STORE_SUBSCRIPTION_READER, SeatBillingService, BILLING_PROVIDER_SEAT_PORT],
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
        SignTemplateEntitlementService,
        LegalAcceptanceService,
        // Privacy Notice 1.1 E-6 — legal-change notice delivery evidence.
        LegalChangeNoticeRepository,
        RenewalNoticeRepository,
        { provide: BILLING_PROVIDER_PORT, useClass: StripeBillingProvider },
        { provide: BILLING_PROVIDER_COMMAND_PORT, useClass: StripeBillingProvider },
        { provide: BILLING_PROVIDER_ADJUSTMENT_PORT, useClass: StripeBillingProvider },
    // Sign Business per-seat pricing — the provider seat quantity (same Stripe adapter) and the seat service.
    { provide: BILLING_PROVIDER_SEAT_PORT, useClass: StripeBillingProvider },
    SeatBillingService,
        { provide: BILLING_PROVIDER_READ_PORT, useClass: StripeBillingReadAdapter },
        BillingStatusReadService,
        SubscriptionLifecycleService,
        BillingCommandService,
        SelfServiceBillingService,
        BillingWebhookInboxService,
        BillingFinanceReportService,
        BillingRevenueReportService,
    CommercialSubscriptionReadService,
        FreePersonalSubscriptionService,
        CommercialAuditRepository,
        CommercialPolicyRepository,
        CommercialOperatorRepository,
        CommercialChangeRequestService,
        CommercialApplyService,
        CommercialCatalogApplyService,
        CommercialPolicyApplyService,
        CommercialPolicyGovernanceService,
        CommercialAuditExportService,
        CommercialOperatorRosterService,
        CommercialConversionLedger,
        CommercialConversionService,
        CommercialBillingAdjustmentLedger,
        CommercialBillingAdjustmentService,
        RefundRemainderGate,
        CommercialRefundReportService,
        SupportExtensionService,
        PlanVersionRepository,
        UsageRollupService,
        CommercialCatalogService,
        ContractRepository,
        ContractPaymentReadService,
        CommercialAlertService,
        MeteredUsageService,
        { provide: USAGE_RECORDER, useExisting: MeteredUsageService },
        { provide: USAGE_METER_REPORT_PORT, useClass: StripeBillingProvider },
        UsageProviderReportService,
        UsagePeriodReconciliationService,
        ...STORE_PROVIDERS,
        ...REGION_PROVIDERS,
        ...(opts.providers ?? []),
      ],
      exports: [BillingRegionService, AllowanceService, CapacityService, SignTemplateEntitlementService, LegalAcceptanceService, LegalChangeNoticeRepository, RenewalNoticeRepository, SubscriptionLifecycleService, FreePersonalSubscriptionService, BILLING_PROVIDER_PORT, CommercialAuditRepository, CommercialPolicyRepository, CommercialOperatorRepository, CommercialChangeRequestService, CommercialApplyService, CommercialCatalogApplyService, CommercialPolicyApplyService, PlanVersionRepository, UsageRollupService, CommercialCatalogService, CommercialPolicyGovernanceService, CommercialAuditExportService, CommercialOperatorRosterService, ContractRepository, ContractPaymentReadService, BILLING_PROVIDER_COMMAND_PORT, BillingCommandService, BillingWebhookInboxService, CommercialConversionLedger, CommercialConversionService, BILLING_PROVIDER_READ_PORT, BillingStatusReadService, BillingFinanceReportService, BillingRevenueReportService, SupportExtensionService, CommercialAlertService, CommercialSubscriptionReadService, SelfServiceBillingService, CommercialBillingAdjustmentLedger, CommercialBillingAdjustmentService, RefundRemainderGate, CommercialRefundReportService, BILLING_PROVIDER_ADJUSTMENT_PORT, MeteredUsageService, USAGE_RECORDER, UsageProviderReportService, UsagePeriodReconciliationService, USAGE_METER_REPORT_PORT, StoreBillingService, BillingProductsService, STORE_SUBSCRIPTION_READER, SeatBillingService, BILLING_PROVIDER_SEAT_PORT],
    };
  }
}
