import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { IdentityIndexModule } from '@aramo/identity-index';
import { ObjectStorageModule } from '@aramo/object-storage';
import { ResumeParseModule } from '@aramo/resume-parse';

import { PrismaService } from './prisma/prisma.service.js';
import { TalentRecordController } from './talent-record.controller.js';
import { TalentRecordRepository } from './talent-record.repository.js';
import { TalentLinkService } from './talent-link.service.js';
import { ResumeTextService } from './resume-text/resume-text.service.js';

// TalentRecordModule — PR-A4 Gate 5 ATS Batch 3.
//
// Import set:
//   - AuthModule          → JwtAuthGuard
//   - AuthorizationModule → RolesGuard
//   - EntitlementModule   → EntitlementGuard
//   - IdentityIndexModule → IdentityIndexRepository (the cluster-exists
//     validation gate for the PERSON_CLUSTER link). DIRECTIONAL EDGE
//     ONLY — `identity-index` does NOT import `talent-record`. No cycle.
//   - ObjectStorageModule (A8-3b) → ObjectStorageService (the E1
//     presigned-PUT helper for résumé uploads).
//   - ResumeParseModule (A8-3b) → ResumeParserService (the E2
//     deterministic parse-to-prefill; NO LLM per ADR-0015 Decision 10).
//     Edge is one-way (talent-record → resume-parse); the inverse
//     would cycle because resume-parse defines the prefill type
//     structurally (libs/resume-parse types/TalentRecordPrefill).
//
// TalentLinkService is the ATS↔identity-index link adapter; it composes
// TalentRecordRepository (the ATS-side write) with IdentityIndexRepository
// (the cluster read-only validation). 4e-rest retired the Core TalentModule
// edge (the Core-Talent link was dropped once engagement #349 + consent #350
// released it).
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    IdentityIndexModule,
    ObjectStorageModule,
    ResumeParseModule,
  ],
  controllers: [TalentRecordController],
  providers: [
    PrismaService,
    TalentRecordRepository,
    TalentLinkService,
    // Search PR-2 — the résumé-text re-extract + persistence service. The
    // enqueue side is consumed by AttachmentController (the commit seam);
    // the drain side by the ResumeReindexProcessor (the separate worker
    // module). ObjectStorageModule + ResumeParseModule (already imported)
    // supply its deps; no new module edge.
    ResumeTextService,
    {
      provide: 'ResumeTextServiceLogger',
      useFactory: () => createAramoLogger(ResumeTextService.name),
    },
  ],
  exports: [TalentRecordRepository, TalentLinkService, ResumeTextService],
})
export class TalentRecordModule {}
