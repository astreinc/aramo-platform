import { Module } from '@nestjs/common';

import { CapacityProjectionRepository } from './capacity/capacity-projection.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// Track 4 / T4-B1 — the placement-owned capacity projection, exposed for
// consumers to PULL (§4: consumers depend on placement; placement NEVER imports
// a consumer). Provides the projection repository + the placement PrismaService
// so a consuming module (requisition, reporting) imports THIS module and reads
// derived capacity — no cross-schema write, no raw cross-schema SQL, and
// placement gains NO outgoing edge. Non-destructive (T4-B1): both authorities
// coexist; nothing is removed until the T4-A2-gated T4-B2 cutover.
@Module({
  providers: [PrismaService, CapacityProjectionRepository],
  exports: [CapacityProjectionRepository],
})
export class PlacementCapacityModule {}
