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
import { PlanVersionRepository } from './plan-version.repository.js';
import { CommercialCatalogService } from './commercial/commercial-catalog.service.js';
import { ContractRepository } from './commercial/commercial-contract.repository.js';
// CCP-C8-PR — the contract payment-status read (PR-10, PR-11).
import { ContractPaymentReadService } from './commercial/commercial-payment-record.js';
import { BILLING_PROVIDER_ADJUSTMENT_PORT, BILLING_PROVIDER_COMMAND_PORT, BILLING_PROVIDER_PORT, BILLING_PROVIDER_READ_PORT } from './billing/billing-provider.port.js';
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
import { UsageRollupService } from './usage/usage-rollup.service.js';

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
    LegalAcceptanceService,
    // Privacy Notice 1.1 E-6 — legal-change notice delivery evidence.
    LegalChangeNoticeRepository,
    { provide: BILLING_PROVIDER_PORT, useClass: StripeBillingProvider },
    { provide: BILLING_PROVIDER_COMMAND_PORT, useClass: StripeBillingProvider },
    { provide: BILLING_PROVIDER_ADJUSTMENT_PORT, useClass: StripeBillingProvider },
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
  ],
  exports: [AllowanceService, CapacityService, LegalAcceptanceService, LegalChangeNoticeRepository, SubscriptionLifecycleService, FreePersonalSubscriptionService, BILLING_PROVIDER_PORT, CommercialAuditRepository, CommercialPolicyRepository, CommercialOperatorRepository, CommercialChangeRequestService, CommercialApplyService, CommercialCatalogApplyService, CommercialPolicyApplyService, PlanVersionRepository, UsageRollupService, CommercialCatalogService, CommercialPolicyGovernanceService, CommercialAuditExportService, CommercialOperatorRosterService, ContractRepository, ContractPaymentReadService, BILLING_PROVIDER_COMMAND_PORT, BillingCommandService, BillingWebhookInboxService, CommercialConversionLedger, CommercialConversionService, BILLING_PROVIDER_READ_PORT, BillingStatusReadService, BillingFinanceReportService, BillingRevenueReportService, SupportExtensionService, CommercialAlertService, CommercialSubscriptionReadService, SelfServiceBillingService, CommercialBillingAdjustmentLedger, CommercialBillingAdjustmentService, RefundRemainderGate, CommercialRefundReportService, BILLING_PROVIDER_ADJUSTMENT_PORT],
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
        // Privacy Notice 1.1 E-6 — legal-change notice delivery evidence.
        LegalChangeNoticeRepository,
        { provide: BILLING_PROVIDER_PORT, useClass: StripeBillingProvider },
        { provide: BILLING_PROVIDER_COMMAND_PORT, useClass: StripeBillingProvider },
        { provide: BILLING_PROVIDER_ADJUSTMENT_PORT, useClass: StripeBillingProvider },
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
        ...(opts.providers ?? []),
      ],
      exports: [AllowanceService, CapacityService, LegalAcceptanceService, LegalChangeNoticeRepository, SubscriptionLifecycleService, FreePersonalSubscriptionService, BILLING_PROVIDER_PORT, CommercialAuditRepository, CommercialPolicyRepository, CommercialOperatorRepository, CommercialChangeRequestService, CommercialApplyService, CommercialCatalogApplyService, CommercialPolicyApplyService, PlanVersionRepository, UsageRollupService, CommercialCatalogService, CommercialPolicyGovernanceService, CommercialAuditExportService, CommercialOperatorRosterService, ContractRepository, ContractPaymentReadService, BILLING_PROVIDER_COMMAND_PORT, BillingCommandService, BillingWebhookInboxService, CommercialConversionLedger, CommercialConversionService, BILLING_PROVIDER_READ_PORT, BillingStatusReadService, BillingFinanceReportService, BillingRevenueReportService, SupportExtensionService, CommercialAlertService, CommercialSubscriptionReadService, SelfServiceBillingService, CommercialBillingAdjustmentLedger, CommercialBillingAdjustmentService, RefundRemainderGate, CommercialRefundReportService, BILLING_PROVIDER_ADJUSTMENT_PORT],
    };
  }
}
