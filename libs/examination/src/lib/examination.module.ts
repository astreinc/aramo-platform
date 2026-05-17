import { Module } from '@nestjs/common';

import { ExaminationRepository } from './examination.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/examination module — M3 PR-1 entity foundation. Wires the
// examination-owned PrismaService and the ExaminationRepository that
// writes / reads TalentJobExamination immutable analytical snapshots
// (Group 2 §2.4).
//
// PR-1 adds no controllers, no HTTP endpoints, no Pact surface. Out of
// scope per directive §4: matching engine, BullMQ wiring, tier-assignment
// logic, Live List, Summary/Full Pact, annotations/overrides, evidence
// packages.
@Module({
  providers: [PrismaService, ExaminationRepository],
  exports: [ExaminationRepository],
})
export class ExaminationModule {}
