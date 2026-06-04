import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AramoExceptionFilter, CommonModule } from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { IdentityModule } from '@aramo/identity';

import { CognitoAdminService } from './cognito/cognito-admin.service.js';
import { PlatformController } from './platform.controller.js';
import { PlatformInvitationService } from './platform-invitation.service.js';

// PlatformModule — wires the platform-admin app's HTTP surface +
// orchestration. Imports:
//   - CommonModule          — AramoError + RequestId + the exception filter.
//   - AuthModule            — JwtAuthGuard for class-level @UseGuards.
//   - AuthorizationModule   — RolesGuard for @RequireScopes-based AuthZ.
//   - IdentityModule        — TenantService + IdentityService (the
//                              identity-tx step of the cross-schema saga).
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
    IdentityModule,
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
