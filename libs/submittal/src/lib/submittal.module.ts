import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { ConsentModule } from '@aramo/consent';
import { EvidenceModule } from '@aramo/evidence';

import { PrismaService } from './prisma/prisma.service.js';
import { SubmittalController } from './submittal.controller.js';
import { SubmittalRepository } from './submittal.repository.js';

// libs/submittal module — M4 PR-3.
//
// Wires:
//   - PrismaService (tenth lazy PrismaService in the workspace) — owns
//     the engagement-schema connection for TalentSubmittalRecord I/O.
//   - SubmittalRepository — write path that orchestrates evidence-package
//     build (via EvidenceRepository.buildPackage) + submittal record write.
//   - SubmittalController — POST /v1/submittals.
//
// Imports:
//   - AuthModule — JwtAuthGuard at class-level on the controller.
//   - EvidenceModule — EvidenceRepository.buildPackage (PR-2's builder).
//   - ConsentModule — IdempotencyService (shared lookup against the
//     consent.IdempotencyKey table; F36 tracks the relocation question).
@Module({
  imports: [AuthModule, EvidenceModule, ConsentModule],
  controllers: [SubmittalController],
  providers: [PrismaService, SubmittalRepository],
  exports: [SubmittalRepository],
})
export class SubmittalModule {}
