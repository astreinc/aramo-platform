import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';

import { PrismaService } from './prisma/prisma.service.js';
import { ClientSelectionProcessRepository } from './client-selection.repository.js';
import { ClientSelectionController } from './client-selection.controller.js';

// Lane 2 / L2-F (F1) — the Client-Selection owner module. Leaf import set
// (lint:nx-boundaries — directional edges only): Auth (JwtAuthGuard),
// Authorization (RolesGuard), Entitlement (EntitlementGuard). No Pipeline import
// edge — Pipeline must never write this owner (I15/SB-7). No back-edge from any of
// the imported modules into this one.
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule],
  controllers: [ClientSelectionController],
  providers: [PrismaService, ClientSelectionProcessRepository],
  // PrismaService is exported so the apps/api create-from-submittal orchestration can
  // bind it (useExisting) as its raw cross-schema read connection — the same singleton
  // the repository writes through (mirrors SubmittalEligibilityModule exporting its
  // PrismaService for SubmitTalentToClientService).
  exports: [ClientSelectionProcessRepository, PrismaService],
})
export class ClientSelectionModule {}
