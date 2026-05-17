import { Module } from '@nestjs/common';
import { ExaminationModule } from '@aramo/examination';

import { MatchingService } from './matching.service.js';

// libs/matching module — M3 PR-2 entrustability engine + persistence
// orchestrator. Imports ExaminationModule for the ExaminationRepository
// it persists snapshots through (§3.3). Stateless — no own
// PrismaService, no Prisma model, no migration (§3.3 ruling, §7 HALT
// guard).
//
// PR-2 adds no controller, no HTTP endpoint, no Pact surface. Out of
// scope per directive §4: matching-analysis layer that populates the
// MatchingAnalysisInput contract, BullMQ/Redis async wiring, Live List
// generation, recruiter-override / submittal / justification surfaces,
// database-backed version registry, Golden Profile / Job entities.
@Module({
  imports: [ExaminationModule],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
