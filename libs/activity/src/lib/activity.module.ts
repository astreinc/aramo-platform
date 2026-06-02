import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';

import { PrismaService } from './prisma/prisma.service.js';
import { ActivityController } from './activity.controller.js';
import { ActivityRepository } from './activity.repository.js';

// ActivityModule — PR-A5a Gate 5 ATS Batch 4a (sidecar to pipeline).
//
// Leaf import set (lint:nx-boundaries — directional edges only):
//   - AuthModule          → JwtAuthGuard
//   - AuthorizationModule → RolesGuard
//   - EntitlementModule   → EntitlementGuard
//
// Activity is STANDALONE — does NOT import @aramo/pipeline. The
// pipeline.module imports this module for the in-tx Activity write at
// status transition (pipeline → activity directional edge). The reverse
// direction never exists; lint:nx-boundaries enforces this.
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule],
  controllers: [ActivityController],
  providers: [PrismaService, ActivityRepository],
  exports: [ActivityRepository],
})
export class ActivityModule {}
