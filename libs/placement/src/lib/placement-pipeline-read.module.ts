import { Module } from '@nestjs/common';

import { AssignmentPipelineReadRepository } from './assignment-pipeline-read.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// T9-B3 — placement-owned READ module exposing the current-state assignment-
// pipeline snapshot aggregate for consumers to PULL over the reporting→placement
// edge (directive §14/§30). Mirrors PlacementCapacityModule / PlacementEventReadModule:
// provides the placement PrismaService + the snapshot read repository and exports
// only the repository, so reporting imports THIS module and reads placement
// current-state with no cross-schema write and no new outgoing placement edge.
@Module({
  providers: [PrismaService, AssignmentPipelineReadRepository],
  exports: [AssignmentPipelineReadRepository],
})
export class PlacementPipelineReadModule {}
