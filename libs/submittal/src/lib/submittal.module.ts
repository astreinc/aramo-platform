import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { createAramoLogger } from '@aramo/common';
import { ConsentModule } from '@aramo/consent';
import { EvidenceModule } from '@aramo/evidence';
import { ExaminationModule } from '@aramo/examination';

import { PrismaService } from './prisma/prisma.service.js';
import { SubmittalController } from './submittal.controller.js';
import { SubmittalRepository } from './submittal.repository.js';
import { TalentSubmittalEventRepository } from './talent-submittal-event.repository.js';

// libs/submittal module — M4 PR-3 (create) + M4 PR-4 (confirm).
//
// Wires:
//   - PrismaService (tenth lazy PrismaService in the workspace) — owns
//     the engagement-schema connection for TalentSubmittalRecord I/O.
//   - SubmittalRepository — write path that orchestrates evidence-package
//     build (via EvidenceRepository.buildPackage) + submittal record write,
//     and the M4 PR-4 confirm path that re-validates the pinned
//     examination + flips state to 'handoff_draft' (M5 PR-8b2 rename).
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
// M4 PR-9 §4.5 — two AramoLogger providers (substrate-natural choice
// per directive's primary option): one keyed by 'SubmittalControllerLogger'
// with factory context SubmittalController.name, one keyed by
// 'SubmittalRepositoryLogger' with factory context SubmittalRepository.name.
// Per-class context preserves the existing SubmittalRepository emit-site
// context discipline (formerly via `new Logger(SubmittalRepository.name)`)
// without requiring callers to pass contextOverride on every emit.
//
// M5 PR-8b1 §4.7 — TalentSubmittalEventRepository provider + Style A
// 'TalentSubmittalEventRepositoryLogger' factory token (mirror PR-2
// engagement-event substrate). Exported so PR-8b2+ wire-in consumers
// can inject it into the existing SubmittalRepository write methods.
@Module({
  imports: [AuthModule, EvidenceModule, ConsentModule, ExaminationModule],
  controllers: [SubmittalController],
  providers: [
    PrismaService,
    SubmittalRepository,
    TalentSubmittalEventRepository,
    {
      provide: 'SubmittalControllerLogger',
      useFactory: () => createAramoLogger(SubmittalController.name),
    },
    {
      provide: 'SubmittalRepositoryLogger',
      useFactory: () => createAramoLogger(SubmittalRepository.name),
    },
    {
      provide: 'TalentSubmittalEventRepositoryLogger',
      useFactory: () => createAramoLogger(TalentSubmittalEventRepository.name),
    },
  ],
  exports: [SubmittalRepository, TalentSubmittalEventRepository],
})
export class SubmittalModule {}
