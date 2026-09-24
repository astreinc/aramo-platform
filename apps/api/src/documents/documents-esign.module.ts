import { Module } from '@nestjs/common';
import {
  DocumentExecutedWriteBackService,
  DocumentIdempotencyService,
  DOCUMENT_STORAGE_PORT,
  type DocumentStoragePort,
  PrismaService as DocumentsPrismaService,
  RevisionSourceService,
} from '@aramo/documents';
import { ObjectStorageModule, ObjectStorageService } from '@aramo/object-storage';

import { AramoS3DocumentStorageAdapter } from './aramo-s3-document-storage.adapter.js';
import {
  DOCUMENTS_ESIGN_PRISMA,
  EsignExecutedArtifactsClient,
  EsignWriteBackOrchestrator,
} from './esign-writeback.js';
import { DocumentsEsignController } from './documents-esign.controller.js';

// DOC-4 (R-4-7) — the apps/api executed-artifact seam module. SELF-CONTAINED: it
// builds its own documents Prisma + storage adapter via factories (mirroring the
// root DOCUMENT_STORAGE_PORT binding) rather than depending on root-only
// providers, so it wires cleanly without disturbing the existing composition.
const DOCUMENTS_ESIGN_STORAGE = 'DOCUMENTS_ESIGN_STORAGE';

@Module({
  imports: [ObjectStorageModule],
  controllers: [DocumentsEsignController],
  providers: [
    { provide: DOCUMENTS_ESIGN_PRISMA, useFactory: (): DocumentsPrismaService => new DocumentsPrismaService() },
    {
      provide: DOCUMENTS_ESIGN_STORAGE,
      useFactory: (storage: ObjectStorageService): DocumentStoragePort => new AramoS3DocumentStorageAdapter(storage),
      inject: [ObjectStorageService],
    },
    // Bind DOCUMENT_STORAGE_PORT locally so the injected services resolve it in
    // this module's scope (the root binding is not exported to sub-modules).
    { provide: DOCUMENT_STORAGE_PORT, useExisting: DOCUMENTS_ESIGN_STORAGE },
    {
      provide: RevisionSourceService,
      useFactory: (prisma: DocumentsPrismaService, storage: DocumentStoragePort): RevisionSourceService =>
        new RevisionSourceService(prisma, storage),
      inject: [DOCUMENTS_ESIGN_PRISMA, DOCUMENTS_ESIGN_STORAGE],
    },
    EsignExecutedArtifactsClient,
    {
      provide: DocumentExecutedWriteBackService,
      useFactory: (prisma: DocumentsPrismaService, storage: DocumentStoragePort): DocumentExecutedWriteBackService =>
        new DocumentExecutedWriteBackService(prisma, storage, new DocumentIdempotencyService(prisma)),
      inject: [DOCUMENTS_ESIGN_PRISMA, DOCUMENTS_ESIGN_STORAGE],
    },
    EsignWriteBackOrchestrator,
  ],
})
export class DocumentsEsignModule {}
