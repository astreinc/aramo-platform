import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { PlacementPipelineInboxRepository } from './placement-pipeline-inbox.repository.js';

// Lane 2 / L2-G (Part 3) — the thin bridge module: exposes the idempotent-consumer inbox
// repository (+ its PrismaService) to the apps/api orchestrator. It imports nothing from
// Placement or Pipeline — it is pure orchestration bookkeeping.
@Module({
  providers: [PrismaService, PlacementPipelineInboxRepository],
  exports: [PlacementPipelineInboxRepository, PrismaService],
})
export class PlacementPipelineBridgeModule {}
