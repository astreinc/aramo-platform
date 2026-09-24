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
import { TalentRecordModule, TalentRecordRepository } from '@aramo/talent-record';

import { AramoS3DocumentStorageAdapter } from '../documents/aramo-s3-document-storage.adapter.js';
import { EsignServiceHttpProvider } from '../esign/esign-service-http.provider.js';

import { RtrController } from './rtr.controller.js';
import { RtrOrchestratorService } from './rtr-orchestrator.service.js';

// DOC-5 (R-5-5) — the RTR composition module. SELF-CONTAINED (own documents
// Prisma + storage + rendering via factories, mirroring DocumentsEsignModule) so
// it wires without disturbing the root composition. STRING tokens for the
// module-local documents repo + render service avoid the bare-class-token
// non-strict-lookup collision. Imports TalentRecordModule (scope:ats — legal in
// untagged apps/api) for authoritative signer resolution.
const RTR_DOCS_PRISMA = 'RTR_DOCS_PRISMA';
const RTR_DOCS_STORAGE = 'RTR_DOCS_STORAGE';
const RTR_DOCS_RENDERING = 'RTR_DOCS_RENDERING';
const RTR_DOCS_REPO = 'RTR_DOCS_REPO';
const RTR_RENDER_SERVICE = 'RTR_RENDER_SERVICE';

@Module({
  imports: [ObjectStorageModule, TalentRecordModule],
  controllers: [RtrController],
  providers: [
    { provide: RTR_DOCS_PRISMA, useFactory: (): DocumentsPrismaService => new DocumentsPrismaService() },
    {
      provide: RTR_DOCS_STORAGE,
      useFactory: (storage: ObjectStorageService): DocumentStoragePort => new AramoS3DocumentStorageAdapter(storage),
      inject: [ObjectStorageService],
    },
    { provide: RTR_DOCS_RENDERING, useFactory: (): DocumentRenderingPort => new PdfLibDocumentRenderingAdapter() },
    { provide: SIGNATURE_PROVIDER_PORT, useClass: EsignServiceHttpProvider },
    {
      provide: RTR_DOCS_REPO,
      useFactory: (prisma: DocumentsPrismaService): DocumentsRepository =>
        new DocumentsRepository(prisma, new DocumentIdempotencyService(prisma)),
      inject: [RTR_DOCS_PRISMA],
    },
    {
      provide: RTR_RENDER_SERVICE,
      useFactory: (prisma: DocumentsPrismaService, rendering: DocumentRenderingPort, storage: DocumentStoragePort): RenderService =>
        new RenderService(prisma, rendering, storage),
      inject: [RTR_DOCS_PRISMA, RTR_DOCS_RENDERING, RTR_DOCS_STORAGE],
    },
    {
      provide: RtrOrchestratorService,
      useFactory: (
        documents: DocumentsRepository,
        render: RenderService,
        signature: SignatureProviderPort,
        talent: TalentRecordRepository,
      ): RtrOrchestratorService => new RtrOrchestratorService(documents, render, signature, talent),
      inject: [RTR_DOCS_REPO, RTR_RENDER_SERVICE, SIGNATURE_PROVIDER_PORT, TalentRecordRepository],
    },
  ],
})
export class RtrModule {}
