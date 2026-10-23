import { Module } from '@nestjs/common';

import { IntelligenceHealthService } from './intelligence-health.service.js';
import { IntelligencePrismaService } from './prisma/intelligence-prisma.service.js';

// ATI-SEP-1 T0 — the Talent Intelligence core module (scope:intelligence).
// Depends only on scope:intelligence + scope:shared (eslint depConstraints).
@Module({
  providers: [IntelligencePrismaService, IntelligenceHealthService],
  exports: [IntelligencePrismaService, IntelligenceHealthService],
})
export class IntelligenceCoreModule {}
