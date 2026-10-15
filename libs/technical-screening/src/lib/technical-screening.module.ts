import { Module, type DynamicModule, type ModuleMetadata, type Type } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import {
  SCREENING_EVIDENCE_PUBLISHER,
  type ScreeningEvidencePublisher,
} from './screening-publisher.port.js';
import { SCREENING_AI_CONSENT, type ScreeningAiConsentPort } from './ai/screening-ai.ports.js';
import { ScreeningAiService } from './ai/screening-ai.service.js';
import { TechnicalScreeningRepository } from './technical-screening.repository.js';
import { TechnicalScreeningService } from './technical-screening.service.js';

// libs/technical-screening — TIP-E2E INC-3 (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §3).
// The domain owns sessions, findings, confirmation and publication tracking.
// The SCREENING_EVIDENCE_PUBLISHER binding is REQUIRED: the composition root
// (apps/api) passes its Talent Trust adapter class to register(), so a missing
// adapter is a compile/bootstrap failure, never a silent fallback. The repository
// is exported for the talent-merge re-key (record-reconcile operational holders).
@Module({})
export class TechnicalScreeningModule {
  static register(options: {
    publisher: Type<ScreeningEvidencePublisher>;
    // INC-3 A1-3 — the REQUIRED ai_processing consent adapter (fail closed).
    // The importing root must also import AiDraftModule (STRUCTURED_GENERATION_PROVIDER).
    aiConsent: Type<ScreeningAiConsentPort>;
    imports?: ModuleMetadata['imports'];
  }): DynamicModule {
    return {
      module: TechnicalScreeningModule,
      imports: options.imports ?? [],
      providers: [
        PrismaService,
        TechnicalScreeningRepository,
        TechnicalScreeningService,
        ScreeningAiService,
        { provide: SCREENING_EVIDENCE_PUBLISHER, useClass: options.publisher },
        { provide: SCREENING_AI_CONSENT, useClass: options.aiConsent },
      ],
      exports: [TechnicalScreeningService, TechnicalScreeningRepository, ScreeningAiService],
    };
  }
}
