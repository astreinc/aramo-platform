import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CommonModule, RequestIdMiddleware } from '@aramo/common';
import {
  DOCUMENT_SOURCE_PROVIDER_PORT,
  EVENT_PUBLISHER_PORT,
  EVIDENCE_MANIFEST_SIGNER_PORT,
  EXECUTION_PRODUCER_PORT,
  EsignModule,
  ExecutionService,
  OutboxService,
  SIGNING_NOTIFICATION_PORT,
  SoftwareEvidenceManifestSigner,
} from '@aramo/esign';
import { DOCUMENT_RENDERING_PORT, PdfLibDocumentRenderingAdapter } from '@aramo/documents-rendering';
import { MailerModule } from '@aramo/mailer';

import { EsignProviderController, EsignSignerController } from './esign-http.controller.js';
import { NativeAramoSignatureProvider } from './native-aramo-signature.provider.js';
import { MailerSigningNotificationAdapter } from './mailer-signing-notification.adapter.js';
import { kmsEvidenceSignerFromEnv } from './kms-evidence-manifest-signer.js';
import { DocumentSourceHttpAdapter } from './document-source-http.adapter.js';
import { eventPublisherFromEnv } from './sns-event-publisher.js';

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
    EsignModule.forRoot({
      imports: [MailerModule],
      evidenceSigner: {
        provide: EVIDENCE_MANIFEST_SIGNER_PORT,
        useFactory: () => kmsEvidenceSignerFromEnv(process.env) ?? new SoftwareEvidenceManifestSigner(),
      },
      extraProviders: [
        { provide: DOCUMENT_RENDERING_PORT, useClass: PdfLibDocumentRenderingAdapter },
        { provide: DOCUMENT_SOURCE_PROVIDER_PORT, useClass: DocumentSourceHttpAdapter },
        { provide: SIGNING_NOTIFICATION_PORT, useClass: MailerSigningNotificationAdapter },
        { provide: EVENT_PUBLISHER_PORT, useFactory: () => eventPublisherFromEnv(process.env) },
        OutboxService,
        { provide: EXECUTION_PRODUCER_PORT, useClass: ExecutionService },
      ],
    }),
  ],
  controllers: [EsignProviderController, EsignSignerController],
  providers: [NativeAramoSignatureProvider],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
