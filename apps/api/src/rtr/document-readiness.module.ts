import { Module } from '@nestjs/common';
import {
  DocumentIdempotencyService,
  DocumentsRepository,
  PrismaService as DocumentsPrismaService,
} from '@aramo/documents';

import { DocumentReadinessGate, DOCUMENT_READINESS_DOCS_REPO } from './document-readiness.gate.js';

// DOC-5 (R-5-7) — provides the DocumentReadinessGate with its own documents
// Prisma + repository (read-only usage: the same-document executed-RTR finder),
// self-contained so it composes into SubmitTalentModule without disturbing the
// root composition. STRING token for the module-local repo avoids the
// bare-class-token non-strict-lookup collision.
const DOCUMENT_READINESS_PRISMA = 'DOCUMENT_READINESS_PRISMA';

@Module({
  providers: [
    { provide: DOCUMENT_READINESS_PRISMA, useFactory: (): DocumentsPrismaService => new DocumentsPrismaService() },
    {
      provide: DOCUMENT_READINESS_DOCS_REPO,
      useFactory: (prisma: DocumentsPrismaService): DocumentsRepository =>
        new DocumentsRepository(prisma, new DocumentIdempotencyService(prisma)),
      inject: [DOCUMENT_READINESS_PRISMA],
    },
    DocumentReadinessGate,
  ],
  exports: [DocumentReadinessGate],
})
export class DocumentReadinessModule {}
