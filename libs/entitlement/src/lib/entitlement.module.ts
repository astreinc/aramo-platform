import { Module } from '@nestjs/common';

import { EntitlementGuard } from './entitlement.guard.js';
import { EntitlementRepository } from './entitlement.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// EntitlementModule — providers for the @RequireCapability guard surface.
// Imported by apps/api AppModule (consumer-side) so the EntitlementGuard
// provider is available to controllers that wire it via
// @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard) per PR-A1b
// Ruling 1.
//
// Distinct from AuthorizationModule (libs/authorization) — this is the
// TENANT axis, not the scope axis. Both are independently composable.
@Module({
  providers: [PrismaService, EntitlementRepository, EntitlementGuard],
  exports: [EntitlementGuard, EntitlementRepository],
})
export class EntitlementModule {}
