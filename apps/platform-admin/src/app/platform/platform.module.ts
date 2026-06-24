import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AramoExceptionFilter, CommonModule } from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { IdentityCoreModule } from '@aramo/identity';

import { CognitoAdminService } from './cognito/cognito-admin.service.js';
import { PlatformController } from './platform.controller.js';
import { PlatformInvitationService } from './platform-invitation.service.js';

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
  ],
  controllers: [PlatformController],
  providers: [
    CognitoAdminService,
    PlatformInvitationService,
    { provide: APP_FILTER, useClass: AramoExceptionFilter },
  ],
})
export class PlatformModule {}
