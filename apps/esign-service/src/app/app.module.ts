import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CommonModule, RequestIdMiddleware } from '@aramo/common';
import {
  DOCUMENT_SOURCE_PROVIDER_PORT,
  DOCUMENT_STORAGE_PORT,
  EVENT_PUBLISHER_PORT,
  EVIDENCE_MANIFEST_SIGNER_PORT,
  EXECUTION_PRODUCER_PORT,
  EsignModule,
  ExecutionService,
  OutboxDeliveryService,
  OutboxService,
  SIGNING_NOTIFICATION_PORT,
  SoftwareEvidenceManifestSigner,
  WEBHOOK_DELIVERY_PORT,
} from '@aramo/esign';
import { DOCUMENT_RENDERING_PORT, PdfLibDocumentRenderingAdapter } from '@aramo/documents-rendering';
import { MailerModule } from '@aramo/mailer';
import { ObjectStorageModule } from '@aramo/object-storage';
import { SubscriptionModule } from '@aramo/subscription';

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

// DOC-3/DOC-4 — apps/esign-service composition root. Composes the ATS-neutral
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
    SubscriptionModule,
    EsignModule.forRoot({
      imports: [MailerModule, ObjectStorageModule],
      // PX-V1 F3 — EsignSignerController (declared at AppModule level) injects the
      // source resolver; export the token so Nest can resolve it at app boot.
      // SIGNING_NOTIFICATION_PORT must cross the boundary too: NativeAramoSignatureProvider
      // (an AppModule provider) @Optional-injects it, and while it was unexported the
      // notifier resolved to undefined — envelopes went SENT but the signer
      // invitation email was silently never sent (prod RTR, 2026-10-16).
      extraExports: [DOCUMENT_SOURCE_PROVIDER_PORT, SIGNING_NOTIFICATION_PORT],
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
        EsignDeliveryWorker,
      ],
    }),
  ],
  controllers: [EsignProviderController, EsignSignerController],
  providers: [NativeAramoSignatureProvider, AramoSignAllowanceGate],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
