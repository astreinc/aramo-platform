import { Module, type DynamicModule, type ModuleMetadata, type Type } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import {
  SCREENING_EVIDENCE_PUBLISHER,
  type ScreeningEvidencePublisher,
} from './screening-publisher.port.js';
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
    imports?: ModuleMetadata['imports'];
  }): DynamicModule {
    return {
      module: TechnicalScreeningModule,
      imports: options.imports ?? [],
      providers: [
        PrismaService,
        TechnicalScreeningRepository,
        TechnicalScreeningService,
        { provide: SCREENING_EVIDENCE_PUBLISHER, useClass: options.publisher },
      ],
      exports: [TechnicalScreeningService, TechnicalScreeningRepository],
    };
  }
}
