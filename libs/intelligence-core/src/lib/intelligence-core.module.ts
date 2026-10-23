import { Module } from '@nestjs/common';

import { ServiceTokenService } from './auth/service-token.service.js';
import { IdentityMergeSplitService } from './identity/merge-split.service.js';
import { IdentityResolutionService } from './identity/identity-resolution.service.js';
import { GOV_ID_TOKENIZER, TalentIngestService } from './ingest/talent-ingest.service.js';
import { IntelligenceHealthService } from './intelligence-health.service.js';
import { GovIdTokenizer } from './normalize.js';
import { IntelligencePrismaService } from './prisma/intelligence-prisma.service.js';
import { PrismaIntelligenceUnitOfWork } from './repositories/prisma-unit-of-work.js';
import { INTELLIGENCE_UNIT_OF_WORK } from './repositories/types.js';

// ATI-SEP-1 — the Talent Intelligence core module (scope:intelligence).
// Depends only on scope:intelligence + scope:shared (eslint depConstraints).
// T0: Prisma + health. T1: repositories / unit of work. T2: ingestion + service
// tokens. T3: identity resolution + merge / split.
@Module({
  providers: [
    IntelligencePrismaService,
    IntelligenceHealthService,
    { provide: INTELLIGENCE_UNIT_OF_WORK, useClass: PrismaIntelligenceUnitOfWork },
    { provide: GOV_ID_TOKENIZER, useFactory: () => GovIdTokenizer.fromEnv() },
    IdentityResolutionService,
    IdentityMergeSplitService,
    TalentIngestService,
    ServiceTokenService,
  ],
  exports: [
    IntelligencePrismaService,
    IntelligenceHealthService,
    INTELLIGENCE_UNIT_OF_WORK,
    IdentityResolutionService,
    IdentityMergeSplitService,
    TalentIngestService,
    ServiceTokenService,
  ],
})
export class IntelligenceCoreModule {}
