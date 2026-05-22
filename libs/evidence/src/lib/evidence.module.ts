import { Module } from '@nestjs/common';
import { ExaminationModule } from '@aramo/examination';
import { TalentEvidenceModule } from '@aramo/talent-evidence';

import { EvidenceRepository } from './evidence.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/evidence module — M4 PR-1 entity foundation + M4 PR-2 builder.
//
// PR-1 (substrate-only) registered PrismaService + the read-only
// EvidenceRepository. PR-2 extends the repository with the buildPackage
// write path and now wires two upstream dependencies that the builder
// consumes (directive §4.4):
//   - ExaminationModule — for ExaminationRepository.findById /
//     findByIdFull (step 2 of the build flow).
//   - TalentEvidenceModule — for TalentEvidenceRepository
//     .findTalentRateExpectationById (step 4 of the build flow, only
//     when input.rate_expectation_id is provided).
//
// EvidenceModule is still NOT imported by apps/api at PR-2 (substrate
// only; no HTTP route consumer). The submittal-create endpoint PR (F33)
// will add the AppModule import alongside its controller.
@Module({
  imports: [ExaminationModule, TalentEvidenceModule],
  providers: [PrismaService, EvidenceRepository],
  exports: [EvidenceRepository],
})
export class EvidenceModule {}
