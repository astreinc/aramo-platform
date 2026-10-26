import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AramoExceptionFilter, CommonModule } from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { AuthorizationResolverModule, IdentityCoreModule } from '@aramo/identity';
import {
  PolicyStore,
  PrismaService as PolicyStorePrismaService,
} from '@aramo/policy-store';
import { AbuseReportService, PrismaService as SignPrismaService } from '@aramo/sign';
import { SubscriptionModule } from '@aramo/subscription';

import { CognitoAdminService } from './cognito/cognito-admin.service.js';
import { DomainClaimSweeper } from './domain-claim-sweeper.service.js';
import { PersonalLapseSweeper } from './personal-lapse-sweeper.service.js';
import { PersonalSignupAttemptPurgeSweeper } from './personal-signup-attempt-purge-sweeper.service.js';
import { PlatformCommercialAuditController } from './platform-commercial-audit.controller.js';
import { PlatformCommercialChangeRequestController } from './platform-commercial-change-request.controller.js';
// CCP-A6 — the transactional apply route (same base path; a separate controller).
import { PlatformCommercialApplyController } from './platform-commercial-apply.controller.js';
import { PlatformCommercialUsageController } from './platform-commercial-usage.controller.js';
import { PlatformCommercialSubscriptionsController } from './platform-commercial-subscriptions.controller.js';
import { PlatformCommercialCatalogController } from './platform-commercial-catalog.controller.js';
import { PlatformCommercialGovernanceController } from './platform-commercial-governance.controller.js';
import { PlatformCommercialContractController } from './platform-commercial-contract.controller.js';
import { PlatformCommercialBillingController } from './platform-commercial-billing.controller.js';
import { PlatformCommercialConversionController } from './platform-commercial-conversion.controller.js';
import { PlatformCommercialBillingAdjustmentController } from './platform-commercial-billing-adjustment.controller.js';
import { PlatformCommercialRefundReportController } from './platform-commercial-refund-report.controller.js';
import { PlatformCommercialBillingStatusController } from './platform-commercial-billing-status.controller.js';
import { PlatformCommercialFinanceController } from './platform-commercial-finance.controller.js';
import { PlatformCommercialRevenueController } from './platform-commercial-revenue.controller.js';
import { PlatformCommercialSupportExtensionController } from './platform-commercial-support-extension.controller.js';
// CCP-D3 — the operational alert register and counts-and-states metrics (read-only), and the
// opt-in scanner (CCP_ALERTS_ENABLED=1).
import { PlatformCommercialObservabilityController } from './platform-commercial-observability.controller.js';
import { CommercialAlertScannerWorker } from './commercial-alert-scanner.service.js';
import { PlatformPersonalController } from './platform-personal.controller.js';
import { PlatformController } from './platform.controller.js';
import { PlatformSignController } from './platform-sign.controller.js';
import { PlatformInvitationService } from './platform-invitation.service.js';
import { TenantPolicyProvisioningService } from './tenant-policy-provisioning.service.js';
import { UsageRollupWorker } from './usage-rollup-worker.service.js';

// PlatformModule — wires the platform-admin app's HTTP surface +
// orchestration. Imports:
//   - CommonModule          — AramoError + RequestId + the exception filter.
//   - AuthModule            — JwtAuthGuard for class-level @UseGuards.
//   - AuthorizationModule   — RolesGuard for @RequireScopes-based AuthZ.
//   - IdentityCoreModule    — TenantService + IdentityService +
//                              RoleBundleValidator (the identity-tx step of the
//                              cross-schema saga). The shared read surface (the
//                              IdentityModule-Split v1.0 split); platform-admin
//                              runs its OWN platform-pool invitation saga
//                              (PlatformInvitationService) and never touches the
//                              tenant invite ports, so it imports the slim core,
//                              not the apps/api-only IdentityModule.
//   - EntitlementModule     — EntitlementRepository for the
//                              entitlement-tx step.
// Local provider: CognitoAdminService (the AWS SDK Cognito-IDP wrapper).
// The exception filter follows the libs/consent + apps/auth-service
// precedent (APP_FILTER + AramoExceptionFilter).
@Module({
  imports: [
    CommonModule,
    AuthModule,
    AuthorizationModule,
    IdentityCoreModule,
    EntitlementModule,
    // Aramo Sign launch — the operator's read-only Sign account view. CCP-A2 — also the
    // CommercialAuditRepository behind the commercial audit feed. CCP-A3 — the
    // CommercialChangeRequestService behind the change-request and approval routes. CCP-B2 —
    // the CommercialCatalogService behind the catalog read and draft routes.
    SubscriptionModule,
    // HF-AUTH-1 — the shared JwtAuthGuard (via AuthModule) resolves effective
    // scopes SERVER-SIDE through this port; without it every platform-admin route
    // would fail closed. Platform operators are consumer_type='platform', resolved
    // from the sentinel-tenant RBAC (UserTenantMembership→role→scope) by the real
    // resolver — no portal sessions here, so portalScopes is empty.
    AuthorizationResolverModule.forRoot({
      portalScopes: [],
      scopeCacheTtlSeconds: 300,
    }),
  ],
  // CCP-A2 — the read-only commercial audit feed (platform:commercial:audit:read).
  // CCP-A3 — commercial change requests and approvals (platform:approval:read gate).
  // CCP-D1 — usage roll-up reconciliation + consumption analytics (platform:subscription:read).
  // CCP-B2 — catalog reads + draft writes.
  // CCP-B5 — policy, audit export and the operator roster.
  // CCP-B4 — enterprise contract reads.
  // CCP-C1 — read-only Stripe command outbox and webhook inbox views (platform:billing:read).
  // CCP-C2 — the governed conversion apply and read (platform:approval:read gate; requester-only apply).
  // CCP-C4 — credits, discounts and refunds: requester-only apply and read (platform:approval:read gate).
  // CCP-C4-P — the read-only refund report (platform:billing:read; amounts with platform:billing:amount:read).
  // CCP-C3 — read-through invoice / payment status and portal configuration (platform:billing:read).
  // CCP-C6 — the read-only Finance reports (platform:billing:read).
  // CCP-D2 — revenue reporting (platform:billing:read; amounts only with platform:billing:amount:read, else FINANCE_SCOPE_REQUIRED).
  // CCP-A8 — the support exception overlay (platform:subscription:support / :read gates).
  // CCP-D3 — read-only alert register and metrics (platform:billing:read / platform:approval:read).
  controllers: [PlatformController, PlatformSignController, PlatformPersonalController, PlatformCommercialAuditController, PlatformCommercialChangeRequestController, PlatformCommercialApplyController, PlatformCommercialUsageController, PlatformCommercialCatalogController, PlatformCommercialGovernanceController, PlatformCommercialContractController, PlatformCommercialBillingController, PlatformCommercialConversionController, PlatformCommercialBillingStatusController, PlatformCommercialFinanceController, PlatformCommercialRevenueController, PlatformCommercialSupportExtensionController, PlatformCommercialObservabilityController, PlatformCommercialSubscriptionsController, PlatformCommercialBillingAdjustmentController, PlatformCommercialRefundReportController],
  providers: [
    // Sign Personal (Free) v1.1 §6.4 — abuse-report outcomes (sign schema; its own
    // generated client, lazy DATABASE_URL — scope:platform → scope:boundary is wall-legal).
    SignPrismaService,
    AbuseReportService,
    CognitoAdminService,
    PlatformInvitationService,
    // ADR-0024 PR-4a-2 — policy-store access for the provisioning-time
    // template copy (scope:platform → scope:boundary is wall-legal). PolicyStore
    // takes the policy-store PrismaService (its own generated client; lazy
    // DATABASE_URL resolution, distinct from the identity client already wired).
    PolicyStorePrismaService,
    PolicyStore,
    TenantPolicyProvisioningService,
    // Domain-Enforcement P3 — opt-in expiry sweep (DOMAIN_CLAIM_SWEEP_ENABLED=1).
    DomainClaimSweeper,
    // Sign Personal (Free) Launch v1.1 — opt-in unbound lapse (SIGN_PERSONAL_LAPSE_SWEEP_ENABLED=1).
    PersonalLapseSweeper,
    // PO / Lead 2026-10-22 — Personal signup-attempt cleanup: abandoned attempts 3 days
    // after expiry, refused attempts after 180 days (ON by default;
    // SIGN_PERSONAL_SIGNUP_PURGE_ENABLED=0 switches it off).
    PersonalSignupAttemptPurgeSweeper,
    // CCP-D1 — opt-in usage roll-up worker (CCP_USAGE_ROLLUP_ENABLED=1; off by default).
    UsageRollupWorker,
    // CCP-D3 — opt-in operational alert scanner (CCP_ALERTS_ENABLED=1; off by default).
    CommercialAlertScannerWorker,
    // DOC-TEMPLATE-LIB-1 T-3 (§5.3) — the RTR-TEMPLATE-1 provisioning-time RTR template
    // COPY is retired: a new tenant gets no RTR template row and resolves to the Aramo
    // (PLATFORM) RTR default. platform-admin no longer touches the documents store.
    { provide: APP_FILTER, useClass: AramoExceptionFilter },
  ],
  // Aramo Sign launch — the public signup module reuses the provisioning saga
  // and the identity store this module wires.
  exports: [PlatformInvitationService, IdentityCoreModule, SubscriptionModule],
})
export class PlatformModule {}
