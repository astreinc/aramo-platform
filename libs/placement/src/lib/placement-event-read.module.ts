import { Module } from '@nestjs/common';

import { PlacementProcessEventRepository } from './placement-process-event.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// T9-B2 — placement-owned READ module exposing the append-only PlacementProcess
// event surface (including the fallthrough cohort aggregate) for consumers to
// PULL over the reporting→placement edge (§11: consumers depend on placement;
// placement NEVER imports a consumer). Mirrors PlacementCapacityModule: provides
// the placement PrismaService + the event-read repository and exports only the
// repository, so a consuming module (reporting) imports THIS module and reads
// placement events with no cross-schema write and no new outgoing placement edge.
@Module({
  providers: [PrismaService, PlacementProcessEventRepository],
  exports: [PlacementProcessEventRepository],
})
export class PlacementEventReadModule {}
