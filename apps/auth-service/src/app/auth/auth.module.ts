import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AramoExceptionFilter, CommonModule } from '@aramo/common';
import { IdentityCoreModule } from '@aramo/identity';
import { AuthStorageModule } from '@aramo/auth-storage';
import { PortalIdentityModule } from '@aramo/portal-identity';
import { IdentityIndexModule } from '@aramo/identity-index';
import { MailerModule } from '@aramo/mailer';

import { AuthController } from './auth.controller.js';
import { CognitoVerifierService } from './cognito-verifier.service.js';
import { CookieVerifierService } from './cookie-verifier.service.js';
import { EMAIL_SENDER } from './email-sender.port.js';
import { ELIGIBILITY_POLICY } from './eligibility-policy.port.js';
import { HostAuthProfileService } from './host-auth-profile.service.js';
import { IdentityIndexEligibilityAdapter } from './identity-index-eligibility.adapter.js';
import { MailerEmailSenderAdapter } from './mailer-email-sender.adapter.js';
import { HostBaseResolver } from './host-base-resolver.service.js';
import { JwksController } from './jwks.controller.js';
import { JwksService } from './jwks.service.js';
import { JwtIssuerService } from './jwt-issuer.service.js';
import { PkceService } from './pkce.service.js';
import { PortalAuthController } from './portal-auth.controller.js';
import { PortalLoginBudget } from './portal-login-budget.js';
import { PortalLoginService } from './portal-login.service.js';
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
  imports: [
    CommonModule,
    IdentityCoreModule,
    AuthStorageModule,
    // Portal P1 — passwordless portal login deps: the portal identity +
    // login-token store, the PII-free index (eligibility fingerprint lookup,
    // aperture 1), and the mailer (magic-link send via the standing mail path).
    //
    // Auth-Decoupling PR-2/3 (§2.4): IdentityIndexModule + MailerModule remain
    // imported at the MODULE level to supply the adapters below — that residual
    // module-level coupling is PR-5's to remove. The SERVICE-level coupling
    // (PortalLoginService importing them directly) is gone, which is this PR's point.
    PortalIdentityModule,
    IdentityIndexModule,
    MailerModule,
  ],
  controllers: [AuthController, JwksController, PortalAuthController],
  providers: [
    PkceService,
    JwtIssuerService,
    CookieVerifierService,
    JwksService,
    CognitoVerifierService,
    SessionOrchestratorService,
    RefreshOrchestratorService,
    HostAuthProfileService,
    HostBaseResolver,
    PortalLoginService,
    PortalLoginBudget,
    // Auth-Decoupling PR-2/3 — bind auth's ports to the Aramo adapters. The
    // adapters are the ONLY code that imports @aramo/mailer / @aramo/identity-index /
    // computeEmailFingerprint; PortalLoginService depends only on the ports.
    { provide: EMAIL_SENDER, useClass: MailerEmailSenderAdapter },
    { provide: ELIGIBILITY_POLICY, useClass: IdentityIndexEligibilityAdapter },
    { provide: APP_FILTER, useClass: AramoExceptionFilter },
  ],
})
export class AuthServiceModule {}
