import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CommonModule, RequestIdMiddleware } from '@aramo/common';
import {
  DOCUMENT_SOURCE_PROVIDER_PORT,
  DOCUMENT_STORAGE_PORT,
  EVENT_PUBLISHER_PORT,
  EVIDENCE_MANIFEST_SIGNER_PORT,
  EXECUTED_ARTIFACT_CUSTODY_PORT,
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
  SignNotificationRepository,
  SignPrivacyRepository,
  SignArtifactCustodyRepository,
  SignRetentionRepository,
  SoftwareEvidenceManifestSigner,
  WEBHOOK_DELIVERY_PORT,
} from '@aramo/sign';
import { DOCUMENT_RENDERING_PORT, PdfLibDocumentRenderingAdapter } from '@aramo/documents-rendering';
import { MailerModule } from '@aramo/mailer';
import { ObjectStorageModule } from '@aramo/object-storage';
import { ORGANIZATION_BILLING_PROFILE_PORT, PLAN_ELIGIBILITY_PORT, RegistryUpcomingLegalChangeSource, SubscriptionModule, UPCOMING_LEGAL_CHANGE_SOURCE } from '@aramo/subscription';
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
// Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED, SX-2 — the
// dedicated Sign artifact bucket (dark unless SIGN_ARTIFACT_BUCKET is set).
import { SignArtifactStore } from './custody/sign-artifact-store.js';
import { ExecutedArtifactCustodyService } from './custody/executed-artifact-custody.service.js';
import { SignArtifactReconcileWorker } from './custody/sign-artifact-reconcile.worker.js';
import { eventPublisherFromEnv } from './sns-event-publisher.js';
import { HttpWebhookEventPublisher } from './webhook-event-publisher.js';
import { EsignDeliveryWorker } from './esign-delivery.worker.js';
import { EsignExpiryWorker } from './esign-expiry.worker.js';
import { SigningInvitationWorker } from './signing-invitation.worker.js';
import { IdentitySenderDirectoryAdapter } from './identity-sender-directory.adapter.js';
import { EsignSenderController } from './sender/esign-sender.controller.js';
import { SenderContextService } from './sender/sender-context.service.js';
import { SenderEnvelopeService } from './sender/sender-envelope.service.js';
import { EsignBillingController } from './billing/esign-billing.controller.js';
import { EsignBillingReconcileWorker } from './billing/esign-billing-reconcile.worker.js';
import { EsignBillingCommandWorker } from './billing/esign-billing-command.worker.js';
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
import { LegalChangeBannerService } from './legal/legal-change-banner.service.js';
import { SignAccountController } from './account/sign-account.controller.js';
import { SignAccountService } from './account/sign-account.service.js';
// Aramo Sign Mobile (M-A3 §4, §9) — saved signatures and the account-close purge of saved data.
import { SavedSignatureController } from './me/signature/saved-signature.controller.js';
import { SavedSignatureService } from './me/signature/saved-signature.service.js';
import { SavedDataPurgeService } from './me/signature/saved-data-purge.service.js';
// Aramo Sign Mobile (M-A3 §1, §2, §9) — notification feed, push devices, preferences, push delivery.
import { SignMeNotificationsController } from './me/notifications/sign-me-notifications.controller.js';
import { SignMeNotificationsService } from './me/notifications/sign-me-notifications.service.js';
import { PUSH_DELIVERY_PORT } from './push/push-delivery.port.js';
import { pushDeliveryFromEnv } from './push/push-delivery.adapters.js';
import { AuthStorageDeviceSessionLiveness, DEVICE_SESSION_LIVENESS } from './push/device-session-liveness.js';
import { NotificationFanoutService } from './push/notification-fanout.service.js';
import { PushDeliveryService } from './push/push-delivery.service.js';
import { NotificationPushWorker } from './push/notification-push.worker.js';
import { ConvenienceDataPurgeService } from './push/convenience-data-purge.service.js';
// Privacy Notice 1.1 remediation (E-1 to E-4) — retention cleanup worker (default off).
import { SignRetentionService } from './retention/sign-retention.service.js';
import { SignRetentionWorker } from './retention/sign-retention.worker.js';
// Aramo-Sign-Mobile-Amendment-M-A7 §3 — privacy requests (in-app, public web) and the
// staged deletion execution (OFF unless SIGN_PRIVACY_DELETION_EXECUTION_ENABLED=1).
import { SignPrivacyRequestController } from './privacy/sign-privacy-request.controller.js';
import { SignPrivacyPublicController } from './privacy/sign-privacy-public.controller.js';
import { PrivacyWebBudget, SignPrivacyRequestService } from './privacy/sign-privacy-request.service.js';
import { SignPrivacyExecutionService } from './privacy/sign-privacy-execution.service.js';
import { SignPrivacyExecutionWorker } from './privacy/sign-privacy-execution.worker.js';

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
    // M-A7 §3 — the public privacy request emails its one-time ownership link.
    MailerModule,
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
        // SX-2 — the Sign artifact bucket. Built at boot from SIGN_ARTIFACT_*: an invalid
        // setting (e.g. a non-integer SIGN_ARTIFACT_RETENTION_DAYS) refuses to boot;
        // SIGN_ARTIFACT_BUCKET unset = dark (sources stay in the platform bucket).
        { provide: SignArtifactStore, useFactory: () => SignArtifactStore.fromEnv(process.env) },
        { provide: DOCUMENT_STORAGE_PORT, useClass: EsignObjectStorageDocumentAdapter },
        // SX-2 item 7 — completion custody (called by ExecutionService) + its reconcile job.
        SignArtifactCustodyRepository,
        { provide: EXECUTED_ARTIFACT_CUSTODY_PORT, useClass: ExecutedArtifactCustodyService },
        SignArtifactReconcileWorker,
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
  controllers: [EsignProviderController, EsignSignerController, EsignSenderController, EsignSenderTemplatesController, EsignBillingController, SignOAuthController, SignApiController, IntegrationAdminController, RecipientInboxController, SignReportController, SignLegalController, SignAccountController, SavedSignatureController, SignMeNotificationsController, SignPrivacyRequestController, SignPrivacyPublicController],
  providers: [
    NativeAramoSignatureProvider,
    AramoSignAllowanceGate,
    SenderContextService,
    SenderEnvelopeService,
    EsignOwnerActivationService,
    EsignBillingReconcileWorker,
    // CCP-C1 — Stripe command outbox + webhook inbox worker (SIGN_BILLING_COMMANDS_ENABLED=1; off by default).
    EsignBillingCommandWorker,
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
    // Privacy Notice 1.1 E-6 — the in-service notice of an upcoming legal version (v1/sign/legal/notices).
    // The upcoming-change source is the E-5 registry resolver (versions in state 'upcoming'),
    // merged with the governed UPCOMING_LEGAL_CHANGES list — one source of truth.
    LegalChangeBannerService,
    { provide: UPCOMING_LEGAL_CHANGE_SOURCE, useFactory: () => new RegistryUpcomingLegalChangeSource() },
    // Aramo Sign Personal (Free) — Settings → Close account (v1/sign/account).
    SignAccountService,
    // Aramo Sign Mobile (M-A3 §4, §9) — saved signatures (v1/sign/me/signature, /initials)
    // and the account-close purge of saved signatures and contacts.
    SavedSignatureService,
    SavedDataPurgeService,
    // Aramo Sign Mobile (M-A3 §1, §2, §9) — feed, devices, preferences; the outbox
    // fan-out + push delivery worker (PUSH_DELIVERY_PORT, SIGN_PUSH_DELIVERY, default
    // disabled); the account-close convenience-data purge.
    SignNotificationRepository,
    SignMeNotificationsService,
    { provide: PUSH_DELIVERY_PORT, useFactory: () => pushDeliveryFromEnv(process.env) },
    { provide: DEVICE_SESSION_LIVENESS, useClass: AuthStorageDeviceSessionLiveness },
    NotificationFanoutService,
    PushDeliveryService,
    NotificationPushWorker,
    ConvenienceDataPurgeService,
    // Privacy Notice 1.1 remediation (E-1 to E-4) — retention cleanup. The worker is OFF
    // unless SIGN_RETENTION_WORKER_ENABLED=1 (E-4 also needs SIGN_RETENTION_QUEUE_CLEANUP_ENABLED=1).
    SignRetentionRepository,
    SignRetentionService,
    SignRetentionWorker,
    // Aramo-Sign-Mobile-Amendment-M-A7 §3 — privacy requests + staged deletion execution.
    SignPrivacyRepository,
    PrivacyWebBudget,
    SignPrivacyRequestService,
    SignPrivacyExecutionService,
    SignPrivacyExecutionWorker,
    // M-A8 §3.5 — the identity retirement port and the dependency inspector are
    // identity-owned (IdentityCoreModule); sign-service no longer binds a Cognito adapter.
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
