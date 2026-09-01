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

import { CognitoAdminService } from './cognito/cognito-admin.service.js';
import { PlatformController } from './platform.controller.js';
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
  controllers: [PlatformController],
  providers: [
    CognitoAdminService,
    PlatformInvitationService,
    // ADR-0024 PR-4a-2 — policy-store access for the provisioning-time
    // template copy (scope:platform → scope:boundary is wall-legal). PolicyStore
    // takes the policy-store PrismaService (its own generated client; lazy
    // DATABASE_URL resolution, distinct from the identity client already wired).
    PolicyStorePrismaService,
    PolicyStore,
    TenantPolicyProvisioningService,
    { provide: APP_FILTER, useClass: AramoExceptionFilter },
  ],
})
export class PlatformModule {}
