import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { IdentityIndexModule } from '@aramo/identity-index';
import { ObjectStorageModule } from '@aramo/object-storage';
import { ResumeParseModule } from '@aramo/resume-parse';
import { TalentExtractionModule } from '@aramo/talent-extraction';
import { CanonicalReconcileModule } from '@aramo/canonical-reconcile';

import { PrismaService } from './prisma/prisma.service.js';
import { TalentRecordController } from './talent-record.controller.js';
import { TalentRecordRepository } from './talent-record.repository.js';
import { TalentRecordReconcileRepository } from './talent-record-reconcile.repository.js';
import { TalentRecordService } from './talent-record.service.js';
import { TalentLinkService } from './talent-link.service.js';
import { ResumeTextService } from './resume-text/resume-text.service.js';
import { ResumeExtractionOrchestrator } from './resume-extraction/resume-extraction.orchestrator.js';
import { ResumeSourceAuthorizer } from './resume-extraction/resume-source-authorizer.js';
import { ResumeEditionIngestionService } from './resume-extraction/resume-edition-ingestion.service.js';

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
    // Add-Talent governed-LLM résumé extraction. TalentExtractionModule →
    // TalentExtractionService.extractResumeDraft (the governed LLM draft
    // extractor, an ats→cip edge — permitted). Governed LLM is the SOLE
    // production résumé fact extractor (TI-1F P0.2); the deterministic mode
    // resolver (SettingsModule/TenantSettingService) is retired here.
    TalentExtractionModule,
    // SKILL-TAX Canonical Reconciliation Activation — the best-effort producer.
    CanonicalReconcileModule,
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
    // TALENT-INTEL-1 (TI-1B) — the shared governed-LLM extraction orchestrator
    // + its authorization seam. The ATTACHMENT (EDIT) resolver port is
    // dependency-inverted and OPTIONAL here: the CREATE path (the only live
    // consumer) needs no resolver; the concrete AttachmentResumeResolver is
    // bound by the composition layer that owns the EDIT re-extraction consumer.
    ResumeSourceAuthorizer,
    ResumeExtractionOrchestrator,
    // TALENT-INTEL-1 TI-1D-C — the shared résumé-edition ingestion composition
    // (document→edition→default policy). Consumed by the confirmed-create block
    // and the resume-editions routes; exported for the apps/api composition layer.
    ResumeEditionIngestionService,
  ],
  exports: [
    TalentRecordRepository,
    TalentRecordReconcileRepository,
    TalentRecordService,
    TalentLinkService,
    ResumeTextService,
    ResumeEditionIngestionService,
  ],
})
export class TalentRecordModule {}
