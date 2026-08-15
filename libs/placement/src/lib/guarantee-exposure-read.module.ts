import { Module } from '@nestjs/common';

import { GuaranteeExposureReadRepository } from './guarantee-exposure-read.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// T7-P4 — placement-owned READ module exposing the guarantee-exposure reporting aggregate for
// consumers to PULL over the reporting→placement edge (directive §3.6). Mirrors
// PlacementPipelineReadModule / PlacementCapacityModule / PlacementEventReadModule: provides
// the placement PrismaService + the read repository and exports only the repository, so
// reporting imports THIS module and reads the immutable PermanentPlacement snapshot with no
// cross-schema write and no new outgoing placement edge.
@Module({
  providers: [PrismaService, GuaranteeExposureReadRepository],
  exports: [GuaranteeExposureReadRepository],
})
export class GuaranteeExposureReadModule {}
