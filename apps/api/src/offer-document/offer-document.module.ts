import { Module } from '@nestjs/common';
import {
  DocumentIdempotencyService,
  DocumentsRepository,
  RenderService,
  PrismaService as DocumentsPrismaService,
  type DocumentStoragePort,
} from '@aramo/documents';
import {
  PdfLibDocumentRenderingAdapter,
  type DocumentRenderingPort,
} from '@aramo/documents-rendering';
import { SIGNATURE_PROVIDER_PORT, type SignatureProviderPort } from '@aramo/documents-contracts';
import { ObjectStorageModule, ObjectStorageService } from '@aramo/object-storage';
import { OfferRepository } from '@aramo/placement';
import { TalentRecordModule, TalentRecordRepository } from '@aramo/talent-record';

import { AramoS3DocumentStorageAdapter } from '../documents/aramo-s3-document-storage.adapter.js';
import { EsignServiceHttpProvider } from '../esign/esign-service-http.provider.js';
import { OfferModule } from '../offer/offer.module.js';

import { OfferDocumentController } from './offer-document.controller.js';
import { OfferDocumentOrchestratorService } from './offer-document-orchestrator.service.js';

// DOC-6 (R-6-4) — the offer-letter composition module. SELF-CONTAINED (own documents
// Prisma + storage + rendering via factories, mirroring RtrModule/DocumentsEsignModule)
// so it wires without disturbing the root composition. STRING tokens for the
// module-local documents repo + render service avoid the bare-class-token
// non-strict-lookup collision. Imports OfferModule for the READ-ONLY OfferRepository
// (PL-1 — the orchestrator only reads the Offer; it never wires OFFER_POLICY_STORE nor
// calls a transition) and TalentRecordModule (scope:ats, legal in untagged apps/api)
// for authoritative server-side signer resolution.
const OFFER_DOCS_PRISMA = 'OFFER_DOCS_PRISMA';
const OFFER_DOCS_STORAGE = 'OFFER_DOCS_STORAGE';
const OFFER_DOCS_RENDERING = 'OFFER_DOCS_RENDERING';
const OFFER_DOCS_REPO = 'OFFER_DOCS_REPO';
const OFFER_DOCS_RENDER_SERVICE = 'OFFER_DOCS_RENDER_SERVICE';

@Module({
  imports: [ObjectStorageModule, TalentRecordModule, OfferModule],
  controllers: [OfferDocumentController],
  providers: [
    { provide: OFFER_DOCS_PRISMA, useFactory: (): DocumentsPrismaService => new DocumentsPrismaService() },
    {
      provide: OFFER_DOCS_STORAGE,
      useFactory: (storage: ObjectStorageService): DocumentStoragePort => new AramoS3DocumentStorageAdapter(storage),
      inject: [ObjectStorageService],
    },
    { provide: OFFER_DOCS_RENDERING, useFactory: (): DocumentRenderingPort => new PdfLibDocumentRenderingAdapter() },
    { provide: SIGNATURE_PROVIDER_PORT, useClass: EsignServiceHttpProvider },
    {
      provide: OFFER_DOCS_REPO,
      useFactory: (prisma: DocumentsPrismaService): DocumentsRepository =>
        new DocumentsRepository(prisma, new DocumentIdempotencyService(prisma)),
      inject: [OFFER_DOCS_PRISMA],
    },
    {
      provide: OFFER_DOCS_RENDER_SERVICE,
      useFactory: (prisma: DocumentsPrismaService, rendering: DocumentRenderingPort, storage: DocumentStoragePort): RenderService =>
        new RenderService(prisma, rendering, storage),
      inject: [OFFER_DOCS_PRISMA, OFFER_DOCS_RENDERING, OFFER_DOCS_STORAGE],
    },
    {
      provide: OfferDocumentOrchestratorService,
      useFactory: (
        documents: DocumentsRepository,
        render: RenderService,
        signature: SignatureProviderPort,
        talent: TalentRecordRepository,
        offers: OfferRepository,
      ): OfferDocumentOrchestratorService => new OfferDocumentOrchestratorService(documents, render, signature, talent, offers),
      inject: [OFFER_DOCS_REPO, OFFER_DOCS_RENDER_SERVICE, SIGNATURE_PROVIDER_PORT, TalentRecordRepository, OfferRepository],
    },
  ],
})
export class OfferDocumentModule {}
