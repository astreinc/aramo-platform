import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CommonModule, RequestIdMiddleware } from '@aramo/common';
import {
  DOCUMENT_SOURCE_PROVIDER_PORT,
  DOCUMENT_STORAGE_PORT,
  EVENT_PUBLISHER_PORT,
  EVIDENCE_MANIFEST_SIGNER_PORT,
  EXECUTION_PRODUCER_PORT,
  ENVELOPE_NOTIFICATION_SERVICE,
  EnvelopeNotificationService,
  EsignModule,
  ExecutionService,
  OutboxDeliveryService,
  OutboxService,
  SENDER_DIRECTORY_PORT,
  SIGNING_NOTIFICATION_PORT,
  STORAGE_ACCOUNTING_PORT,
  SoftwareEvidenceManifestSigner,
  WEBHOOK_DELIVERY_PORT,
} from '@aramo/sign';
import { DOCUMENT_RENDERING_PORT, PdfLibDocumentRenderingAdapter } from '@aramo/documents-rendering';
import { MailerModule } from '@aramo/mailer';
import { ObjectStorageModule } from '@aramo/object-storage';
import { ORGANIZATION_BILLING_PROFILE_PORT, PLAN_ELIGIBILITY_PORT, SubscriptionModule } from '@aramo/subscription';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { AuthorizationResolverModule, IdentityCoreModule } from '@aramo/identity';

import { EsignProviderController, EsignSignerController } from './esign-http.controller.js';
import { NativeAramoSignatureProvider } from './native-aramo-signature.provider.js';
import { AramoSignAllowanceGate } from './aramo-sign-allowance.gate.js';
import { MailerSigningNotificationAdapter } from './mailer-signing-notification.adapter.js';
import { kmsEvidenceSignerFromEnv } from './kms-evidence-manifest-signer.js';
import { DocumentSourceHttpAdapter } from './document-source-http.adapter.js';
import { EnvelopeDocumentSourceResolver } from './envelope-document-source.resolver.js';
import { EsignObjectStorageDocumentAdapter } from './esign-object-storage-document.adapter.js';
import { eventPublisherFromEnv } from './sns-event-publisher.js';
import { HttpWebhookEventPublisher } from './webhook-event-publisher.js';
import { EsignDeliveryWorker } from './esign-delivery.worker.js';
import { EsignExpiryWorker } from './esign-expiry.worker.js';
import { SigningInvitationWorker } from './signing-invitation.worker.js';
import { IdentitySenderDirectoryAdapter } from './identity-sender-directory.adapter.js';
import { EsignSenderController } from './sender/esign-sender.controller.js';
import { SenderContextService } from './sender/sender-context.service.js';
import { SenderEnvelopeService } from './sender/sender-envelope.service.js';
import { SenderMembersService } from './sender/sender-members.service.js';
import { EsignBillingController } from './billing/esign-billing.controller.js';
import { EsignBillingReconcileWorker } from './billing/esign-billing-reconcile.worker.js';
import { EsignOwnerActivationService } from './billing/esign-owner-activation.service.js';
import { AramoSignStorageGate } from './billing/aramo-sign-storage.gate.js';
import { AtsPlanEligibilityAdapter } from './billing/ats-plan-eligibility.adapter.js';
import { OrganizationBillingProfileAdapter } from './billing/organization-billing-profile.adapter.js';
import { IntegrationAdminController } from './integrations/integration-admin.controller.js';
import { RecipientInboxController } from './inbox/recipient-inbox.controller.js';
import { RecipientInboxService } from './inbox/recipient-inbox.service.js';
import { IntegrationAdminService } from './integrations/integration-admin.service.js';
import { SignApiController, SignOAuthController } from './integrations/sign-api.controller.js';
import { SignApiGuard } from './integrations/sign-api.guard.js';
import { SignApiService } from './integrations/sign-api.service.js';
import { SignTokenService } from './integrations/sign-token.service.js';
import { SignWebhookDeliveryService } from './integrations/webhook-delivery.service.js';
import { DOCUMENT_TEMPLATES_PORT, DocumentTemplatesHttpAdapter } from './document-templates-http.adapter.js';
import { SignFeatureGate } from './sign-feature.gate.js';
import { EsignSenderTemplatesController } from './sender/esign-sender-templates.controller.js';
import { SenderTemplatesService } from './sender/sender-templates.service.js';
import { PersonalSendGate } from './personal/personal-send.gate.js';
import { SignReportController } from './personal/sign-report.controller.js';
import { ReportBudget, SignReportService } from './personal/sign-report.service.js';
import { SignLegalController } from './legal/sign-legal.controller.js';
import { PersonalLegalStatusService } from './legal/personal-legal-status.service.js';

// DOC-3/DOC-4 — apps/sign-service composition root. Composes the ATS-neutral
// E-Sign domain (EsignModule.forRoot) and binds the full DOC-4 executed-document
// producer chain in the SAME module scope so EsignService's optional
// EXECUTION_PRODUCER_PORT resolves: rendering (pdf-lib), source pull (HTTP to
// apps/api), signing notification (Mailer), the evidence signer (KMS when
// configured, else software), and the operational event bus (SNS when
// configured, else the local no-op) + transactional outbox.
@Module({
  imports: [
    CommonModule,
    // Multi-Provider directive §B — the plan/subscription allowance authority.
    // A1 — Standard Professional eligibility reads the live ATS entitlement.
    SubscriptionModule.forRoot({
      imports: [EntitlementModule, IdentityCoreModule],
      // Sign Signup A1 §2.6 — checkout reads the (US) organization billing profile.
      providers: [
        { provide: PLAN_ELIGIBILITY_PORT, useClass: AtsPlanEligibilityAdapter },
        { provide: ORGANIZATION_BILLING_PROFILE_PORT, useClass: OrganizationBillingProfileAdapter },
      ],
    }),
    // PX-V1 §8 (D-2) — the authenticated sender zone (v1/sign/sender/*). The
    // shared JwtAuthGuard resolves effective scopes SERVER-SIDE through the
    // authorization resolver (identity + entitlement reads, same DATABASE_URL);
    // EntitlementGuard enforces the tenant `sign` capability; RolesGuard the scope.
    // Signer + internal surfaces mount none of these guards and are unchanged.
    AuthModule,
    AuthorizationModule,
    IdentityCoreModule,
    EntitlementModule,
    AuthorizationResolverModule.forRoot({ portalScopes: [], scopeCacheTtlSeconds: 300 }),
    EsignModule.forRoot({
      // IdentityCoreModule: the sender directory resolves console senders' contacts.
      // SubscriptionModule: A1 storage measurement of signed copies / certificates.
      imports: [MailerModule, ObjectStorageModule, IdentityCoreModule, SubscriptionModule],
      // PX-V1 F3 — EsignSignerController (declared at AppModule level) injects the
      // source resolver; export the token so Nest can resolve it at app boot.
      // SIGNING_NOTIFICATION_PORT must cross the boundary too: NativeAramoSignatureProvider
      // (an AppModule provider) @Optional-injects it, and while it was unexported the
      // notifier resolved to undefined — envelopes went SENT but the signer
      // invitation email was silently never sent (prod RTR, 2026-10-16).
      extraExports: [DOCUMENT_SOURCE_PROVIDER_PORT, SIGNING_NOTIFICATION_PORT, DOCUMENT_STORAGE_PORT, ENVELOPE_NOTIFICATION_SERVICE],
      evidenceSigner: {
        provide: EVIDENCE_MANIFEST_SIGNER_PORT,
        useFactory: () => kmsEvidenceSignerFromEnv(process.env) ?? new SoftwareEvidenceManifestSigner(),
      },
      extraProviders: [
        { provide: DOCUMENT_RENDERING_PORT, useClass: PdfLibDocumentRenderingAdapter },
        // PX-V1 F1 — source resolution dispatches on source_mode: CORE_REF via the
        // HTTP adapter (legacy ATS pull), OWNED via E-Sign's own object storage.
        DocumentSourceHttpAdapter,
        { provide: DOCUMENT_STORAGE_PORT, useClass: EsignObjectStorageDocumentAdapter },
        { provide: DOCUMENT_SOURCE_PROVIDER_PORT, useClass: EnvelopeDocumentSourceResolver },
        { provide: SIGNING_NOTIFICATION_PORT, useClass: MailerSigningNotificationAdapter },
        { provide: EVENT_PUBLISHER_PORT, useFactory: () => eventPublisherFromEnv(process.env) },
        OutboxService,
        { provide: EXECUTION_PRODUCER_PORT, useClass: ExecutionService },
        // E-Sign OC v2 — canonical outbound lifecycle-event delivery: HMAC-signed
        // webhook publisher + the durable-outbox delivery service + the lifecycle
        // worker that drains it (E-Sign owns reliable delivery + retry).
        { provide: WEBHOOK_DELIVERY_PORT, useClass: HttpWebhookEventPublisher },
        OutboxDeliveryService,
        // Sign Unified Product S-5 — per-subscription webhook delivery (drained by the worker).
        SignWebhookDeliveryService,
        EsignDeliveryWorker,
        // Aramo Sign launch — lifecycle notifications (with delivery records), the
        // console-sender directory, and the envelope expiry sweep.
        { provide: SENDER_DIRECTORY_PORT, useClass: IdentitySenderDirectoryAdapter },
        { provide: ENVELOPE_NOTIFICATION_SERVICE, useClass: EnvelopeNotificationService },
        EsignExpiryWorker,
        // Multi-Signer §4 — retries undelivered SEQUENTIAL next-signer invitations.
        SigningInvitationWorker,
        // A1 — kept artifacts (signed copies, certificates) count toward storage.
        { provide: STORAGE_ACCOUNTING_PORT, useClass: AramoSignStorageGate },
      ],
    }),
  ],
  // Aramo Sign launch — self-service billing (v1/sign/billing), the governed
  // subscribing-owner activation and the provider reconciliation sweep.
  // Sign Unified Product S-4 — the Sign token endpoint, the Sign API and the
  // workspace's installation administration.
  // DOC-TEMPLATE-LIB-1 T-5 — the sender's template routes (Documents API over the signed channel).
  controllers: [EsignProviderController, EsignSignerController, EsignSenderController, EsignSenderTemplatesController, EsignBillingController, SignOAuthController, SignApiController, IntegrationAdminController, RecipientInboxController, SignReportController, SignLegalController],
  providers: [
    NativeAramoSignatureProvider,
    AramoSignAllowanceGate,
    SenderContextService,
    SenderEnvelopeService,
    SenderMembersService,
    EsignOwnerActivationService,
    EsignBillingReconcileWorker,
    AramoSignStorageGate,
    SignTokenService,
    SignApiGuard,
    SignApiService,
    IntegrationAdminService,
    // Sign Unified Product S-7 — the recipient inbox.
    RecipientInboxService,
    // DOC-TEMPLATE-LIB-1 T-5 — start an envelope from a Documents template.
    SignFeatureGate,
    { provide: DOCUMENT_TEMPLATES_PORT, useClass: DocumentTemplatesHttpAdapter },
    SenderTemplatesService,
    // Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED — the Personal sending
    // gate (inert while SIGN_PERSONAL_SIGNUP_MODE is off) and "Report this email".
    PersonalSendGate,
    ReportBudget,
    SignReportService,
    // Aramo Sign Personal (Free) — the Personal legal documents still to accept
    // (v1/sign/legal; consulted by the Personal send gate).
    PersonalLegalStatusService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
