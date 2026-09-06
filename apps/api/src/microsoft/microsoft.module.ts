import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CommunicationsModule } from '@aramo/communications';
import { ConsentModule } from '@aramo/consent';
import { EntitlementModule } from '@aramo/entitlement';
import { IntegrationModule } from '@aramo/integration';
import {
  DELEGATED_TOKEN_STORE,
  DelegatedAuthorizationService,
  MICROSOFT_GRAPH_PORT,
  MICROSOFT_OAUTH_PORT,
  PROVIDER_IDENTITY_STORE,
  type DelegatedTokenStorePort,
  type MicrosoftOAuthPort,
  type ProviderIdentityStorePort,
} from '@aramo/microsoft-graph';

import { ConsentEmailGateAdapter } from './consent-email-gate.adapter.js';
import { DelegatedTokenSecretStoreAdapter } from './delegated-token-secret-store.adapter.js';
import { EMAIL_CONSENT_GATE } from './email-consent-gate.port.js';
import { MicrosoftAuthorizationController } from './microsoft-authorization.controller.js';
import { MicrosoftAuthorizationOrchestrator } from './microsoft-authorization.orchestrator.js';
import { MicrosoftCallbackController } from './microsoft-callback.controller.js';
import { MicrosoftConfigResolver } from './microsoft-config.resolver.js';
import { MicrosoftEmailService } from './microsoft-email.service.js';
import { MicrosoftMeetingService } from './microsoft-meeting.service.js';
import { MicrosoftGraphHttpAdapter } from './microsoft-graph-http.adapter.js';
import { MicrosoftOAuthHttpAdapter } from './microsoft-oauth-http.adapter.js';
import { ProviderIdentityStoreAdapter } from './provider-identity-store.adapter.js';

// COMM-C2B composition root. Wires the provider-neutral DelegatedAuthorization
// service to its concrete adapters (Graph HTTP, MS token HTTP, Secrets-Manager
// custody, CommunicationProviderIdentity store). Microsoft-specific code lives
// only here + the adapters (R20). Its own communications Prisma client backs the
// identity store so no communications-lib export is required.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    IntegrationModule,
    CommunicationsModule,
    ConsentModule,
  ],
  controllers: [MicrosoftAuthorizationController, MicrosoftCallbackController],
  providers: [
    MicrosoftOAuthHttpAdapter,
    MicrosoftGraphHttpAdapter,
    DelegatedTokenSecretStoreAdapter,
    ProviderIdentityStoreAdapter,
    ConsentEmailGateAdapter,
    MicrosoftConfigResolver,
    { provide: MICROSOFT_OAUTH_PORT, useExisting: MicrosoftOAuthHttpAdapter },
    { provide: MICROSOFT_GRAPH_PORT, useExisting: MicrosoftGraphHttpAdapter },
    { provide: DELEGATED_TOKEN_STORE, useExisting: DelegatedTokenSecretStoreAdapter },
    { provide: PROVIDER_IDENTITY_STORE, useExisting: ProviderIdentityStoreAdapter },
    { provide: EMAIL_CONSENT_GATE, useExisting: ConsentEmailGateAdapter },
    {
      provide: DelegatedAuthorizationService,
      useFactory: (
        oauth: MicrosoftOAuthPort,
        store: DelegatedTokenStorePort,
        identities: ProviderIdentityStorePort,
      ) => new DelegatedAuthorizationService(oauth, store, identities),
      inject: [MICROSOFT_OAUTH_PORT, DELEGATED_TOKEN_STORE, PROVIDER_IDENTITY_STORE],
    },
    MicrosoftAuthorizationOrchestrator,
    MicrosoftEmailService,
    MicrosoftMeetingService,
  ],
})
export class MicrosoftModule {}
