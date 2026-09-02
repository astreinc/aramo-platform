import { Module } from '@nestjs/common';

import { PreStartReportingRepository } from './pre-start-reporting.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// L5-P8 — pre-start-owned READ module exposing the reporting-facing onboarding
// rollup for consumers to PULL over the reporting→pre-start-requirement edge
// (directive Amendment A1, option (a)). Mirrors PlacementEventReadModule: it
// provides the pre-start PrismaService + the read repository and exports ONLY
// the read repository, so a consuming module (reporting) imports THIS module and
// reads the aggregate with no cross-schema write and no new outgoing pre-start
// edge. pre-start NEVER imports a consumer (no back-edge → acyclic).
@Module({
  providers: [PrismaService, PreStartReportingRepository],
  exports: [PreStartReportingRepository],
})
export class PreStartReportingReadModule {}
