import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CommunicationsModule } from '@aramo/communications';
import { ConsentModule } from '@aramo/consent';
import { EntitlementModule } from '@aramo/entitlement';
import { IntegrationModule } from '@aramo/integration';
import { PipelineModule } from '@aramo/pipeline';
import { RequisitionModule } from '@aramo/requisition';
import { TalentRecordModule } from '@aramo/talent-record';
import {
  DELEGATED_TOKEN_STORE,
  DelegatedAuthorizationService,
  MICROSOFT_CALENDAR_PORT,
  MICROSOFT_MEETING_ARTIFACTS_PORT,
  MICROSOFT_GRAPH_PORT,
  MICROSOFT_OAUTH_PORT,
  PROVIDER_IDENTITY_STORE,
  type DelegatedTokenStorePort,
  type MicrosoftOAuthPort,
  type ProviderIdentityStorePort,
} from '@aramo/microsoft-graph';

import { CALENDAR_INVITE_CONSENT_GATE } from './calendar-invite-consent-gate.port.js';
import { ConsentCalendarInviteGateAdapter } from './calendar-invite-consent-gate.adapter.js';
import { ConsentEmailGateAdapter } from './consent-email-gate.adapter.js';
import { MeetingAssociationValidator } from './meeting-association.validator.js';
import { DelegatedTokenSecretStoreAdapter } from './delegated-token-secret-store.adapter.js';
import { EMAIL_CONSENT_GATE } from './email-consent-gate.port.js';
import { EMAIL_RECIPIENT_RESOLVER } from './email-recipient-resolver.port.js';
import { TalentEmailRecipientAdapter } from './talent-email-recipient.adapter.js';
import { MicrosoftAuthorizationController } from './microsoft-authorization.controller.js';
import { MicrosoftAuthorizationOrchestrator } from './microsoft-authorization.orchestrator.js';
import { MicrosoftCallbackController } from './microsoft-callback.controller.js';
import { MicrosoftConfigResolver } from './microsoft-config.resolver.js';
import { MicrosoftEmailService } from './microsoft-email.service.js';
import { MicrosoftMeetingService } from './microsoft-meeting.service.js';
import { MicrosoftSchedulingService } from './microsoft-scheduling.service.js';
import { MicrosoftCalendarHttpAdapter } from './microsoft-calendar-http.adapter.js';
import { MicrosoftGraphHttpAdapter } from './microsoft-graph-http.adapter.js';
import { MicrosoftOAuthHttpAdapter } from './microsoft-oauth-http.adapter.js';
import { MicrosoftMeetingArtifactsHttpAdapter } from './microsoft-meeting-artifacts-http.adapter.js';
import { MeetingArtifactsService } from './meeting-artifacts.service.js';
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
    TalentRecordModule,
    // A1 (M365-SCHED-1, C-4) — composition-root reads for tenant-ownership +
    // recruiting-association validation (RequisitionRepository.findStatusById,
    // PipelineRepository.findLiveEpisode). apps/api edge only.
    RequisitionModule,
    // COMM-C4 — composition-root read/act into Pipeline for the governed
    // no_contact→contacted orchestration on email acceptance (R6; apps/api edge
    // only, NO libs/communications → pipeline dependency).
    PipelineModule,
  ],
  controllers: [MicrosoftAuthorizationController, MicrosoftCallbackController],
  providers: [
    MicrosoftOAuthHttpAdapter,
    MicrosoftGraphHttpAdapter,
    DelegatedTokenSecretStoreAdapter,
    ProviderIdentityStoreAdapter,
    ConsentEmailGateAdapter,
    ConsentCalendarInviteGateAdapter,
    MeetingAssociationValidator,
    TalentEmailRecipientAdapter,
    MicrosoftConfigResolver,
    { provide: EMAIL_RECIPIENT_RESOLVER, useExisting: TalentEmailRecipientAdapter },
    { provide: CALENDAR_INVITE_CONSENT_GATE, useExisting: ConsentCalendarInviteGateAdapter },
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
    // A1 (M365-SCHED-1) — Outlook calendar adapter (default retry policy) + the
    // opt-in scheduling orchestration service.
    { provide: MICROSOFT_CALENDAR_PORT, useFactory: () => new MicrosoftCalendarHttpAdapter() },
    MicrosoftSchedulingService,
    // TIP-E2E INC-3 A1 (Part E/F) — delegated Teams meeting artifacts for
    // screening meetings (organizer token only; post-meeting transcripts).
    { provide: MICROSOFT_MEETING_ARTIFACTS_PORT, useFactory: () => new MicrosoftMeetingArtifactsHttpAdapter() },
    MeetingArtifactsService,
  ],
  // TIP-E2E INC-3 A1 — the screening API composes screening meetings through the
  // existing scheduling service and the meeting-artifact service.
  exports: [MicrosoftSchedulingService, MeetingArtifactsService],
})
export class MicrosoftModule {}
