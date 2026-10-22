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
import { PlatformPersonalController } from './platform-personal.controller.js';
import { PlatformController } from './platform.controller.js';
import { PlatformSignController } from './platform-sign.controller.js';
import { PlatformInvitationService } from './platform-invitation.service.js';
import { TenantPolicyProvisioningService } from './tenant-policy-provisioning.service.js';

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
    // Aramo Sign launch — the operator's read-only Sign account view.
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
  controllers: [PlatformController, PlatformSignController, PlatformPersonalController],
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
