import { Module } from '@nestjs/common';

import { EvidenceRepository } from './evidence.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/evidence module — M4 PR-1 entity foundation.
//
// Substrate-only at PR-1: providers register PrismaService (the ninth
// lazy PrismaService in the workspace) and EvidenceRepository (read-
// only surface). No controllers, no HTTP surface; the module is not
// imported by apps/api at PR-1 (no HTTP route consumer yet).
//
// Subsequent M4 PRs (evidence-package builder, submittal endpoints)
// will consume EvidenceRepository via this module's exports.
@Module({
  providers: [PrismaService, EvidenceRepository],
  exports: [EvidenceRepository],
})
export class EvidenceModule {}
