import { Module } from '@nestjs/common';
import {
  DocumentExecutedWriteBackService,
  DocumentIdempotencyService,
  DocumentsRepository,
  DOCUMENT_STORAGE_PORT,
  type DocumentStoragePort,
  PrismaService as DocumentsPrismaService,
  RevisionSourceService,
} from '@aramo/documents';
import { ObjectStorageModule, ObjectStorageService } from '@aramo/object-storage';
import { SignatureRoutingStoreModule } from '@aramo/signature-routing';

import { SignApiClient } from '../sign/sign-api.client.js';
import { EsignEventsController } from '../integrations/sign/esign-events.controller.js';
import { EsignServiceRequestGuard } from '../integrations/sign/esign-service-request.guard.js';

import { AramoS3DocumentStorageAdapter } from './aramo-s3-document-storage.adapter.js';
import {
  DOCUMENTS_ESIGN_PRISMA,
  EsignExecutedArtifactsClient,
  EsignWriteBackOrchestrator,
} from './esign-writeback.js';
import { DocumentsEsignController } from './documents-esign.controller.js';
import { EsignSigningEndedRecorder } from './esign-signing-ended.js';
import { EsignPurgeRecorder } from './esign-purge.js';

// DOC-4 (R-4-7) — the apps/api executed-artifact seam module. SELF-CONTAINED: it
// builds its own documents Prisma + storage adapter via factories (mirroring the
// root DOCUMENT_STORAGE_PORT binding) rather than depending on root-only
// providers, so it wires cleanly without disturbing the existing composition.
const DOCUMENTS_ESIGN_STORAGE = 'DOCUMENTS_ESIGN_STORAGE';

@Module({
  imports: [ObjectStorageModule, SignatureRoutingStoreModule],
  controllers: [DocumentsEsignController, EsignEventsController],
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
    // Addendum S6 — the ATS client of the Sign API (event-bound artifact grants).
    SignApiClient,
    EsignExecutedArtifactsClient,
    {
      provide: DocumentExecutedWriteBackService,
      useFactory: (prisma: DocumentsPrismaService, storage: DocumentStoragePort): DocumentExecutedWriteBackService =>
        new DocumentExecutedWriteBackService(prisma, storage, new DocumentIdempotencyService(prisma)),
      inject: [DOCUMENTS_ESIGN_PRISMA, DOCUMENTS_ESIGN_STORAGE],
    },
    EsignWriteBackOrchestrator,
    // Pipeline & RTR Recon Remediation Directive v1.0 R2 (DEF-12) — declined / expired / voided
    // envelopes recorded on their governed Document.
    {
      provide: DocumentsRepository,
      useFactory: (prisma: DocumentsPrismaService): DocumentsRepository =>
        new DocumentsRepository(prisma, new DocumentIdempotencyService(prisma)),
      inject: [DOCUMENTS_ESIGN_PRISMA],
    },
    EsignSigningEndedRecorder,
    // Retention and Purge directive (ebd41d99) W11 — Sign's copy queued / dequeued / purged.
    EsignPurgeRecorder,
    // ES-2 — authenticates sign-service requests on the source route.
    EsignServiceRequestGuard,
  ],
})
export class DocumentsEsignModule {}
