import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { IdentityIndexModule } from '@aramo/identity-index';
import { ObjectStorageModule } from '@aramo/object-storage';
import { ResumeParseModule } from '@aramo/resume-parse';
import { SettingsModule } from '@aramo/settings';
import { TalentExtractionModule } from '@aramo/talent-extraction';

import { PrismaService } from './prisma/prisma.service.js';
import { TalentRecordController } from './talent-record.controller.js';
import { TalentRecordRepository } from './talent-record.repository.js';
import { TalentRecordReconcileRepository } from './talent-record-reconcile.repository.js';
import { TalentRecordService } from './talent-record.service.js';
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
// (the cluster read-only validation). 4e-rest made the link CLUSTER-ONLY once
// selection #349 + consent #350 released their former identity reads.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    IdentityIndexModule,
    ObjectStorageModule,
    ResumeParseModule,
    // Add-Talent governed-LLM résumé extraction (LOCKED). SettingsModule →
    // TenantSettingService (the resume.extraction_mode mode resolver);
    // TalentExtractionModule → TalentExtractionService.extractResumeDraft (the
    // governed LLM draft extractor, an ats→cip edge — permitted). Both are
    // consumed ONLY by the draft-from-resume handler.
    SettingsModule,
    TalentExtractionModule,
  ],
  controllers: [TalentRecordController],
  providers: [
    PrismaService,
    TalentRecordRepository,
    // Promotion Gate Slice-B1 — reconcile writes (enrich + provenance +
    // pending contradictions). Consumed by the apps/api reconcile poll above
    // the I15 wall (mirrors TalentRecordRepository's cross-lib export).
    TalentRecordReconcileRepository,
    TalentRecordService,
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
  exports: [
    TalentRecordRepository,
    TalentRecordReconcileRepository,
    TalentRecordService,
    TalentLinkService,
    ResumeTextService,
  ],
})
export class TalentRecordModule {}
