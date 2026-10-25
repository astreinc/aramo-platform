import { type DynamicModule, Module, type ModuleMetadata, type Provider } from '@nestjs/common';

import { AllowanceService } from './allowance.service.js';
import { CapacityService } from './capacity.service.js';
import { CommercialAuditRepository } from './commercial/commercial-audit.repository.js';
import { CommercialPolicyRepository } from './commercial/commercial-policy.repository.js';
import { CommercialChangeRequestService } from './commercial/commercial-change-request.service.js';
import { CommercialApplyService } from './commercial/commercial-apply.service.js';
// CCP-B2-backend — the governed catalog publish / retire apply.
import { CommercialCatalogApplyService } from './commercial/commercial-catalog-apply.service.js';
import { CommercialOperatorRepository } from './commercial/commercial-operator.repository.js';
import { CommercialAuditExportService } from './commercial/commercial-audit-export.service.js';
import { CommercialOperatorRosterService } from './commercial/commercial-operator-roster.service.js';
import { CommercialPolicyGovernanceService } from './commercial/commercial-policy-governance.service.js';
import { CommercialConversionLedger } from './commercial/commercial-conversion.ledger.js';
import { CommercialConversionService } from './commercial/commercial-conversion.service.js';
import { FreePersonalSubscriptionService } from './free-personal-subscription.js';
import { LegalAcceptanceService } from './legal/legal-acceptance.service.js';
import { PlanVersionRepository } from './plan-version.repository.js';
import { CommercialCatalogService } from './commercial/commercial-catalog.service.js';
import { ContractRepository } from './commercial/commercial-contract.repository.js';
import { BILLING_PROVIDER_COMMAND_PORT, BILLING_PROVIDER_PORT, BILLING_PROVIDER_READ_PORT } from './billing/billing-provider.port.js';
import { BillingStatusReadService } from './billing/billing-status-read.service.js';
import { StripeBillingReadAdapter } from './billing/stripe-billing-read.adapter.js';
import { BillingCommandService } from './billing/billing-command.service.js';
import { BillingWebhookInboxService } from './billing/billing-webhook-inbox.service.js';
import { BillingFinanceReportService } from './billing/billing-finance-report.service.js';
import { StripeBillingProvider } from './billing/stripe-billing.provider.js';
import { SubscriptionLifecycleService } from './billing/subscription-lifecycle.service.js';
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
@Module({
  providers: [
    PrismaService,
    AllowanceService,
    CapacityService,
    LegalAcceptanceService,
    { provide: BILLING_PROVIDER_PORT, useClass: StripeBillingProvider },
    { provide: BILLING_PROVIDER_COMMAND_PORT, useClass: StripeBillingProvider },
    { provide: BILLING_PROVIDER_READ_PORT, useClass: StripeBillingReadAdapter },
    BillingStatusReadService,
    SubscriptionLifecycleService,
    BillingCommandService,
    BillingWebhookInboxService,
    BillingFinanceReportService,
    FreePersonalSubscriptionService,
    CommercialAuditRepository,
    CommercialPolicyRepository,
    CommercialOperatorRepository,
    CommercialChangeRequestService,
    CommercialApplyService,
    CommercialCatalogApplyService,
    CommercialPolicyGovernanceService,
    CommercialAuditExportService,
    CommercialOperatorRosterService,
    CommercialConversionLedger,
    CommercialConversionService,
    PlanVersionRepository,
    UsageRollupService,
    CommercialCatalogService,
    ContractRepository,
  ],
  exports: [AllowanceService, CapacityService, LegalAcceptanceService, SubscriptionLifecycleService, FreePersonalSubscriptionService, BILLING_PROVIDER_PORT, CommercialAuditRepository, CommercialPolicyRepository, CommercialOperatorRepository, CommercialChangeRequestService, CommercialApplyService, CommercialCatalogApplyService, PlanVersionRepository, UsageRollupService, CommercialCatalogService, CommercialPolicyGovernanceService, CommercialAuditExportService, CommercialOperatorRosterService, ContractRepository, BILLING_PROVIDER_COMMAND_PORT, BillingCommandService, BillingWebhookInboxService, CommercialConversionLedger, CommercialConversionService, BILLING_PROVIDER_READ_PORT, BillingStatusReadService, BillingFinanceReportService],
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
        { provide: BILLING_PROVIDER_COMMAND_PORT, useClass: StripeBillingProvider },
        { provide: BILLING_PROVIDER_READ_PORT, useClass: StripeBillingReadAdapter },
        BillingStatusReadService,
        SubscriptionLifecycleService,
        BillingCommandService,
        BillingWebhookInboxService,
        BillingFinanceReportService,
        FreePersonalSubscriptionService,
        CommercialAuditRepository,
        CommercialPolicyRepository,
        CommercialOperatorRepository,
        CommercialChangeRequestService,
        CommercialApplyService,
        CommercialCatalogApplyService,
        CommercialPolicyGovernanceService,
        CommercialAuditExportService,
        CommercialOperatorRosterService,
        CommercialConversionLedger,
        CommercialConversionService,
        PlanVersionRepository,
        UsageRollupService,
        CommercialCatalogService,
        ContractRepository,
        ...(opts.providers ?? []),
      ],
      exports: [AllowanceService, CapacityService, LegalAcceptanceService, SubscriptionLifecycleService, FreePersonalSubscriptionService, BILLING_PROVIDER_PORT, CommercialAuditRepository, CommercialPolicyRepository, CommercialOperatorRepository, CommercialChangeRequestService, CommercialApplyService, CommercialCatalogApplyService, PlanVersionRepository, UsageRollupService, CommercialCatalogService, CommercialPolicyGovernanceService, CommercialAuditExportService, CommercialOperatorRosterService, ContractRepository, BILLING_PROVIDER_COMMAND_PORT, BillingCommandService, BillingWebhookInboxService, CommercialConversionLedger, CommercialConversionService, BILLING_PROVIDER_READ_PORT, BillingStatusReadService, BillingFinanceReportService],
    };
  }
}
