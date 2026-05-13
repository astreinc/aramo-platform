import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AramoExceptionFilter, CommonModule } from '@aramo/common';
import { IdentityModule } from '@aramo/identity';
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
// crypto helpers, and HTTP controllers; consumes IdentityModule (for user/
// tenant/role/audit services) and AuthStorageModule (refresh-token
// persistence). Exception envelope filter follows the libs/consent
// precedent (APP_FILTER + AramoExceptionFilter).
@Module({
  imports: [CommonModule, IdentityModule, AuthStorageModule],
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
