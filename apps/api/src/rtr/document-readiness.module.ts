import { Module } from '@nestjs/common';
import {
  DocumentIdempotencyService,
  DocumentsRepository,
  PrismaService as DocumentsPrismaService,
} from '@aramo/documents';
import { RequisitionModule, RequisitionRepository } from '@aramo/requisition';

import { ClientSubmittalPolicyModule } from '../client-submittal-policy/client-submittal-policy.module.js';

import {
  DocumentReadinessGate,
  DOCUMENT_READINESS_DOCS_REPO,
  DOCUMENT_READINESS_REQUISITION_COMPANY_ID,
  type RequisitionCompanyIdResolver,
} from './document-readiness.gate.js';

// DOC-5 (R-5-7) — provides the DocumentReadinessGate with its own documents
// Prisma + repository (read-only usage: the same-document executed-RTR finder),
// self-contained so it composes into SubmitTalentModule without disturbing the
// root composition. STRING token for the module-local repo avoids the
// bare-class-token non-strict-lookup collision.
const DOCUMENT_READINESS_PRISMA = 'DOCUMENT_READINESS_PRISMA';

@Module({
  imports: [
    // The ONE canonical effective-RTR-requirement authority: applicability is a
    // policy fact (`rtr_present` disposition REQUIRED), never a DocumentRequirement row.
    ClientSubmittalPolicyModule,
    // The gate resolves a requisition's owning company_id (to read the effective
    // CLIENT-layer policy) through the shared RequisitionRepository — its typed
    // findCompanyId method, reused, not re-implemented. RequisitionModule is a leaf
    // import (no back-edge to this module); the port below is a STRING token so no
    // bare-class-token non-strict-lookup collision is introduced.
    RequisitionModule,
  ],
  providers: [
    { provide: DOCUMENT_READINESS_PRISMA, useFactory: (): DocumentsPrismaService => new DocumentsPrismaService() },
    {
      provide: DOCUMENT_READINESS_DOCS_REPO,
      useFactory: (prisma: DocumentsPrismaService): DocumentsRepository =>
        new DocumentsRepository(prisma, new DocumentIdempotencyService(prisma)),
      inject: [DOCUMENT_READINESS_PRISMA],
    },
    {
      provide: DOCUMENT_READINESS_REQUISITION_COMPANY_ID,
      useFactory: (requisitions: RequisitionRepository): RequisitionCompanyIdResolver => ({
        findCompanyId: (args) => requisitions.findCompanyId(args),
      }),
      inject: [RequisitionRepository],
    },
    DocumentReadinessGate,
  ],
  exports: [DocumentReadinessGate],
})
export class DocumentReadinessModule {}
