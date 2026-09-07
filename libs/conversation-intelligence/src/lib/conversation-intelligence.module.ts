import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { RequisitionPrismaService } from '@aramo/requisition';
import {
  JobDomainRepository,
  PrismaService as JobDomainPrismaService,
} from '@aramo/job-domain';

import { PrismaService } from './prisma/prisma.service.js';
import { RequisitionAnalysisContextSnapshotRepository } from './requisition-analysis-context-snapshot.repository.js';
import { RequisitionAnalysisContextSnapshotService } from './requisition-analysis-context-snapshot.service.js';
import { REQUISITION_ANALYSIS_CONTEXT_READER } from './reader/requisition-analysis-context-reader.js';
import { RequisitionGoldenProfileContextReader } from './reader/requisition-golden-profile-context.reader.js';

// libs/conversation-intelligence module — CI-B2 (Immutable Requisition
// Analysis Context). Per Aramo-CI-Conversation-Intelligence-Directive-
// v1_2-LOCKED.md §3.4 / §10 + ADR-0031.
//
// This seam registers the snapshot substrate + its Requisition/
// GoldenProfile read adapter self-contained (no HTTP route consumer at
// CI-B2 — a substrate seam; CI-B6 wires the orchestration consumer):
//   - PrismaService (conversation_intelligence schema) — the snapshot
//     store.
//   - RequisitionAnalysisContextSnapshotRepository / ...Service — the
//     create-only + read surface and the capture orchestration.
//   - The reader adapter (RequisitionGoldenProfileContextReader) bound
//     to the REQUISITION_ANALYSIS_CONTEXT_READER token, plus its cross-
//     lib read dependencies: the requisition module's PrismaService
//     (RequisitionPrismaService, for the strict-allowlist Requisition
//     read) and the job_domain JobDomainRepository (+ its PrismaService)
//     for GoldenProfile content. Each is a DISTINCT PrismaService class
//     (own @@schema), so there is no bare-class-token collision — the
//     three connect to the same DATABASE_URL, different schemas.
//
// Exports = the snapshot service only; the repository, reader, and the
// borrowed cross-lib prisma providers are module-internal.
@Module({
  imports: [],
  providers: [
    PrismaService,
    RequisitionAnalysisContextSnapshotRepository,
    RequisitionAnalysisContextSnapshotService,
    // Cross-lib read dependencies for the reader adapter.
    RequisitionPrismaService,
    JobDomainPrismaService,
    JobDomainRepository,
    {
      provide: REQUISITION_ANALYSIS_CONTEXT_READER,
      useClass: RequisitionGoldenProfileContextReader,
    },
    {
      provide: 'RequisitionAnalysisContextSnapshotServiceLogger',
      useFactory: () =>
        createAramoLogger(RequisitionAnalysisContextSnapshotService.name),
    },
    {
      provide: 'RequisitionAnalysisContextSnapshotRepositoryLogger',
      useFactory: () =>
        createAramoLogger(RequisitionAnalysisContextSnapshotRepository.name),
    },
  ],
  exports: [RequisitionAnalysisContextSnapshotService],
})
export class ConversationIntelligenceModule {}
