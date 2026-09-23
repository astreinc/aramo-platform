import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import {
  CommunicationsModule,
  REQUISITION_EXISTENCE_PORT,
  VoiceProviderRegistry,
  ZoomPhoneAdapter,
} from '@aramo/communications';
import { ConsentModule } from '@aramo/consent';
import { EntitlementModule } from '@aramo/entitlement';
import { IdentityCoreModule } from '@aramo/identity';
import { IntegrationModule } from '@aramo/integration';
import { PipelineModule } from '@aramo/pipeline';
import { RequisitionModule } from '@aramo/requisition';
import { TalentRecordModule } from '@aramo/talent-record';

import { ConversationTranscriptZoomModule } from '../conversation-transcript/conversation-transcript-zoom.module.js';
import { EMAIL_RECIPIENT_RESOLVER } from '../microsoft/email-recipient-resolver.port.js';
import { TalentEmailRecipientAdapter } from '../microsoft/talent-email-recipient.adapter.js';

import { CommunicationsController } from './communications.controller.js';
import { TalentCommunicationsController } from './talent-communications.controller.js';
import { CommunicationsApiService } from './communications-api.service.js';
import { CommunicationCallService } from './communication-call.service.js';
import { CommunicationTimelineService } from './communication-timeline.service.js';
import { RequisitionContactDraftController } from './requisition-contact-draft.controller.js';
import { RequisitionContactDraftService } from './requisition-contact-draft.service.js';
import { REQUISITION_CONTACT_TEMPLATE_RESOLVER } from './requisition-contact-template.port.js';
import { SystemRequisitionContactTemplateService } from './system-requisition-contact-template.service.js';
import { RequisitionExistenceAdapter } from './requisition-existence.adapter.js';
import { ZoomWebhookController } from './zoom-webhook.controller.js';
import { ZoomWebhookService } from './zoom-webhook.service.js';
import { ZoomWebhookSecretResolver } from './zoom-webhook-secret.resolver.js';

// COMM-B2/B3 (Aramo-COMM-V1) — apps/api composition root for the /v1/communications
// surface. Imports the domain CommunicationsModule (repository + empty
// VoiceProviderRegistry + per-module PrismaService), the guard modules for the
// three-axis authorization, and IntegrationModule (COMM-B3) so the service can
// resolve the tenant's provider connection (composition-root read into
// @aramo/integration — NO libs/communications → integration nx edge).
//
// COMM-B3 registers the real ZoomPhoneAdapter into the (module-scoped)
// VoiceProviderRegistry under the locked key `zoom_phone` (replacing the B2 fake).
// The adapter's static capability descriptor is CI-safe; live Zoom calls stay
// behind the VoiceProvider port (B5/B6/B8). Capability resolution binds by the
// tenant connection's provider_key — there is NO default/fake fallback.
const ZOOM_VOICE_PROVIDER_REGISTRAR = Symbol('ZOOM_VOICE_PROVIDER_REGISTRAR');

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    CommunicationsModule,
    IntegrationModule,
    // COMM-B5 composition-root reads: consent gate + platform idempotency
    // (ConsentModule), Talent phone-slot resolution (TalentRecordModule), and
    // the requisition existence check behind the comms-owned port
    // (RequisitionModule). All are apps/api imports — NO libs/communications edge.
    ConsentModule,
    TalentRecordModule,
    RequisitionModule,
    // COMM-C2A — composition-root read/act into Pipeline for the governed
    // no_contact→contacted orchestration (PipelineRepository). apps/api edge only;
    // NO libs/communications → pipeline dependency (R6).
    PipelineModule,
    // COMM-C4 (RCE-1) — read-only identity surface for the requisition-contact
    // draft (recruiter display_name + tenant display name). IdentityCoreModule
    // is the slim shared read module (NOT the dynamic IdentityModule).
    IdentityCoreModule,
    // CI-B5Z — the Conversation-Intelligence Zoom transcript composition. Exports
    // ZOOM_TRANSCRIPT_EVENT_HANDLER, which ZoomWebhookService @Optional-injects to
    // route phone.recording_transcript_completed into the CI acquisition flow.
    ConversationTranscriptZoomModule,
  ],
  controllers: [
    CommunicationsController,
    ZoomWebhookController,
    TalentCommunicationsController,
    RequisitionContactDraftController,
  ],
  providers: [
    CommunicationsApiService,
    CommunicationCallService,
    // COMM-C4 (RCE-1) — requisition-contact draft generation. Reuses the C
    // recipient resolver (TalentEmailRecipientAdapter) so the recipient authority
    // model is identical to the send path; the governed template is code-owned.
    RequisitionContactDraftService,
    TalentEmailRecipientAdapter,
    { provide: EMAIL_RECIPIENT_RESOLVER, useExisting: TalentEmailRecipientAdapter },
    SystemRequisitionContactTemplateService,
    { provide: REQUISITION_CONTACT_TEMPLATE_RESOLVER, useExisting: SystemRequisitionContactTemplateService },
    // COMM-B7 — disposition write + Talent communication timeline read.
    CommunicationTimelineService,
    // COMM-B6 — Zoom webhook ingress (HMAC-verified, un-JWT'd; wired here at the
    // composition root alongside the connection/inbox/consent reads it needs).
    ZoomWebhookService,
    ZoomWebhookSecretResolver,
    // Bind the comms-owned requisition existence port to its apps/api reader.
    RequisitionExistenceAdapter,
    { provide: REQUISITION_EXISTENCE_PORT, useExisting: RequisitionExistenceAdapter },
    {
      provide: ZOOM_VOICE_PROVIDER_REGISTRAR,
      useFactory: (registry: VoiceProviderRegistry): true => {
        const adapter = new ZoomPhoneAdapter();
        if (!registry.has(adapter.providerKey())) {
          registry.register(adapter);
        }
        return true;
      },
      inject: [VoiceProviderRegistry],
    },
  ],
})
export class CommunicationsApiModule {}
