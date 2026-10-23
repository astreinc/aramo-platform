import { Module } from '@nestjs/common';
import { IntelligenceCoreModule } from '@aramo/intelligence-core';

import { HealthController } from './health.controller.js';

// ATI-SEP-1 T0 — composition root. Imports scope:intelligence + scope:shared
// libraries ONLY (eslint depConstraints; never an ATS or Pipeline library).
@Module({
  imports: [IntelligenceCoreModule],
  controllers: [HealthController],
})
export class AppModule {}
