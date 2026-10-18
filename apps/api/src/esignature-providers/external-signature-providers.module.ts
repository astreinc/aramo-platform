import { Module } from '@nestjs/common';
import {
  DocumentExecutedWriteBackService,
  DocumentIdempotencyService,
  type DocumentStoragePort,
  PrismaService as DocumentsPrismaService,
  RevisionSourceService,
} from '@aramo/documents';
import { IntegrationModule } from '@aramo/integration';
import { ObjectStorageModule, ObjectStorageService } from '@aramo/object-storage';
import { SignatureRoutingRepository, SignatureRoutingStoreModule } from '@aramo/signature-routing';

import { AramoS3DocumentStorageAdapter } from '../documents/aramo-s3-document-storage.adapter.js';

import { AdobeSignAdapter } from './adobe-sign/adobe-sign.adapter.js';
import { adobeSignConfigFromEnv, type AdobeSignConfig } from './adobe-sign/adobe-sign.config.js';
import { ADOBE_SIGN_CONFIG } from './adobe-sign/adobe-sign.tokens.js';
import { AdobeSignWebhookController } from './adobe-sign/adobe-sign-webhook.controller.js';
import { DocuSignAdapter } from './docusign/docusign.adapter.js';
import { docuSignConfigFromEnv, type DocuSignConfig } from './docusign/docusign.config.js';
import { DOCUSIGN_CONFIG } from './docusign/docusign.tokens.js';
import { DocuSignWebhookController } from './docusign/docusign-webhook.controller.js';
import type { ExternalSignatureAdapter } from './external-signature-adapter.js';
import { EXTERNAL_SIGNATURE_ADAPTERS, ProviderCompletionService } from './provider-completion.service.js';
import { ProviderCredentialStore } from './provider-credential-store.js';

// Multi-Provider directive §F/§G — external e-signature providers. An adapter is
// registered ONLY when its app registration is configured for this environment;
// otherwise the provider reads "not available" everywhere. Self-contained documents
// wiring (same factory pattern as DocumentsEsignModule).
const EXT_DOCS_PRISMA = 'EXT_SIGN_DOCS_PRISMA';
const EXT_DOCS_STORAGE = 'EXT_SIGN_DOCS_STORAGE';

@Module({
  imports: [IntegrationModule, ObjectStorageModule, SignatureRoutingStoreModule],
  controllers: [DocuSignWebhookController, AdobeSignWebhookController],
  providers: [
    { provide: EXT_DOCS_PRISMA, useFactory: (): DocumentsPrismaService => new DocumentsPrismaService() },
    {
      provide: EXT_DOCS_STORAGE,
      useFactory: (storage: ObjectStorageService): DocumentStoragePort => new AramoS3DocumentStorageAdapter(storage),
      inject: [ObjectStorageService],
    },
    {
      provide: RevisionSourceService,
      useFactory: (prisma: DocumentsPrismaService, storage: DocumentStoragePort): RevisionSourceService => new RevisionSourceService(prisma, storage),
      inject: [EXT_DOCS_PRISMA, EXT_DOCS_STORAGE],
    },
    {
      provide: DocumentExecutedWriteBackService,
      useFactory: (prisma: DocumentsPrismaService, storage: DocumentStoragePort): DocumentExecutedWriteBackService =>
        new DocumentExecutedWriteBackService(prisma, storage, new DocumentIdempotencyService(prisma)),
      inject: [EXT_DOCS_PRISMA, EXT_DOCS_STORAGE],
    },
    ProviderCredentialStore,
    { provide: DOCUSIGN_CONFIG, useFactory: (): DocuSignConfig | null => docuSignConfigFromEnv() },
    { provide: ADOBE_SIGN_CONFIG, useFactory: (): AdobeSignConfig | null => adobeSignConfigFromEnv() },
    {
      provide: EXTERNAL_SIGNATURE_ADAPTERS,
      useFactory: (
        docusign: DocuSignConfig | null,
        adobe: AdobeSignConfig | null,
        store: ProviderCredentialStore,
        routes: SignatureRoutingRepository,
        source: RevisionSourceService,
      ): ExternalSignatureAdapter[] => {
        const adapters: ExternalSignatureAdapter[] = [];
        if (docusign !== null) adapters.push(new DocuSignAdapter(docusign, store, routes, source));
        if (adobe !== null) adapters.push(new AdobeSignAdapter(adobe, store, routes, source));
        return adapters;
      },
      inject: [DOCUSIGN_CONFIG, ADOBE_SIGN_CONFIG, ProviderCredentialStore, SignatureRoutingRepository, RevisionSourceService],
    },
    ProviderCompletionService,
  ],
  exports: [EXTERNAL_SIGNATURE_ADAPTERS, ProviderCredentialStore],
})
export class ExternalSignatureProvidersModule {}
