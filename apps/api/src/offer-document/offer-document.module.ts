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
import { ObjectStorageModule, ObjectStorageService } from '@aramo/object-storage';
import { OfferRepository } from '@aramo/placement';
import { TalentRecordModule, TalentRecordRepository } from '@aramo/talent-record';

import { AramoS3DocumentStorageAdapter } from '../documents/aramo-s3-document-storage.adapter.js';
import { GovernedDocumentSigningService } from '../document-signing/governed-document-signing.service.js';
import { SignatureRoutingModule } from '../document-signing/signature-routing.module.js';
import { SignatureRoutingService } from '../document-signing/signature-routing.service.js';
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
// The shared governed-document signing capability, wired module-locally from the SAME documents
// repo + render + signature instances (explicit STRING token — avoids the bare-class-token
// non-strict-lookup collision, consistent with the other module-local providers).
const OFFER_DOCS_SIGNING = 'OFFER_DOCS_SIGNING';

@Module({
  imports: [ObjectStorageModule, TalentRecordModule, OfferModule, SignatureRoutingModule],
  controllers: [OfferDocumentController],
  providers: [
    { provide: OFFER_DOCS_PRISMA, useFactory: (): DocumentsPrismaService => new DocumentsPrismaService() },
    {
      provide: OFFER_DOCS_STORAGE,
      useFactory: (storage: ObjectStorageService): DocumentStoragePort => new AramoS3DocumentStorageAdapter(storage),
      inject: [ObjectStorageService],
    },
    { provide: OFFER_DOCS_RENDERING, useFactory: (): DocumentRenderingPort => new PdfLibDocumentRenderingAdapter() },
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
      provide: OFFER_DOCS_SIGNING,
      useFactory: (
        documents: DocumentsRepository,
        render: RenderService,
        router: SignatureRoutingService,
      ): GovernedDocumentSigningService => new GovernedDocumentSigningService(documents, render, router),
      inject: [OFFER_DOCS_REPO, OFFER_DOCS_RENDER_SERVICE, SignatureRoutingService],
    },
    {
      provide: OfferDocumentOrchestratorService,
      useFactory: (
        signing: GovernedDocumentSigningService,
        talent: TalentRecordRepository,
        offers: OfferRepository,
      ): OfferDocumentOrchestratorService => new OfferDocumentOrchestratorService(signing, talent, offers),
      inject: [OFFER_DOCS_SIGNING, TalentRecordRepository, OfferRepository],
    },
  ],
})
export class OfferDocumentModule {}
