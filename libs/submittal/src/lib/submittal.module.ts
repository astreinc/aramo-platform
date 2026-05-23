import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { ConsentModule } from '@aramo/consent';
import { EvidenceModule } from '@aramo/evidence';
import { ExaminationModule } from '@aramo/examination';

import { PrismaService } from './prisma/prisma.service.js';
import { SubmittalController } from './submittal.controller.js';
import { SubmittalRepository } from './submittal.repository.js';

// libs/submittal module — M4 PR-3 (create) + M4 PR-4 (confirm).
//
// Wires:
//   - PrismaService (tenth lazy PrismaService in the workspace) — owns
//     the engagement-schema connection for TalentSubmittalRecord I/O.
//   - SubmittalRepository — write path that orchestrates evidence-package
//     build (via EvidenceRepository.buildPackage) + submittal record write,
//     and the M4 PR-4 confirm path that re-validates the pinned
//     examination + flips state to 'submitted'.
//   - SubmittalController — POST /v1/submittals (PR-3) +
//     POST /v1/submittals/{id}/confirm (PR-4).
//
// Imports:
//   - AuthModule — JwtAuthGuard at class-level on the controller.
//   - EvidenceModule — EvidenceRepository.buildPackage (PR-2's builder).
//   - ConsentModule — IdempotencyService (shared lookup against the
//     consent.IdempotencyKey table; F36 tracks the relocation question).
//   - ExaminationModule (M4 PR-4 §4.5) — ExaminationRepository.findByIdFull
//     + findLatestByTenantTalentJob, both consumed by confirmSubmittal's
//     pinned-examination re-validation.
@Module({
  imports: [AuthModule, EvidenceModule, ConsentModule, ExaminationModule],
  controllers: [SubmittalController],
  providers: [PrismaService, SubmittalRepository],
  exports: [SubmittalRepository],
})
export class SubmittalModule {}
