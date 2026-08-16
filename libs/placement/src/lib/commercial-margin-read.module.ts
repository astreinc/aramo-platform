import { Module } from '@nestjs/common';

import { CommercialMarginReadRepository } from './commercial-margin-read.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// T9-B4 — placement-owned READ module exposing the current-snapshot commercial
// margin aggregate for consumers to PULL over the reporting→placement edge
// (directive §19/§35). Mirrors PlacementPipelineReadModule / PlacementCapacityModule:
// provides the placement PrismaService + the margin read repository and exports
// ONLY the repository, so reporting imports THIS module and reads placement
// commercial truth with no cross-schema write, no broad PlacementRepository, and
// no new outgoing placement edge.
@Module({
  providers: [PrismaService, CommercialMarginReadRepository],
  exports: [CommercialMarginReadRepository],
})
export class CommercialMarginReadModule {}
