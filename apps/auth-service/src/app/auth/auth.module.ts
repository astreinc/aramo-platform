import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AramoExceptionFilter, CommonModule } from '@aramo/common';
import { IdentityCoreModule } from '@aramo/identity';
import { AuthStorageModule } from '@aramo/auth-storage';

import { AuthController } from './auth.controller.js';
import { CognitoVerifierService } from './cognito-verifier.service.js';
import { CookieVerifierService } from './cookie-verifier.service.js';
import { JwksController } from './jwks.controller.js';
import { JwksService } from './jwks.service.js';
import { JwtIssuerService } from './jwt-issuer.service.js';
import { PkceService } from './pkce.service.js';
import { RefreshOrchestratorService } from './refresh-orchestrator.service.js';
import { SessionOrchestratorService } from './session-orchestrator.service.js';

// PR-8.0a-Reground apps/auth-service local module. Wires the orchestrators,
// crypto helpers, and HTTP controllers; consumes IdentityCoreModule (for user/
// tenant/role/audit services) and AuthStorageModule (refresh-token
// persistence). Exception envelope filter follows the libs/consent
// precedent (APP_FILTER + AramoExceptionFilter).
//
// Auth-Hardening IdentityModule-Split v1.0 — imports IdentityCoreModule (the
// shared read surface), NOT IdentityModule. auth-service never invites tenant
// users (the Cognito invite saga is apps/api's), so it needs none of the
// invite-port surface; importing the slim IdentityModule statically would
// re-create the second stub-bound instance the split removes.
@Module({
  imports: [CommonModule, IdentityCoreModule, AuthStorageModule],
  controllers: [AuthController, JwksController],
  providers: [
    PkceService,
    JwtIssuerService,
    CookieVerifierService,
    JwksService,
    CognitoVerifierService,
    SessionOrchestratorService,
    RefreshOrchestratorService,
    { provide: APP_FILTER, useClass: AramoExceptionFilter },
  ],
})
export class AuthServiceModule {}
