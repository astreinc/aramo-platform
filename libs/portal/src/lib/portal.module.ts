import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { ConsentModule } from '@aramo/consent';
import { EntitlementModule } from '@aramo/entitlement';
import { TalentModule } from '@aramo/talent';

import { PortalController } from './portal.controller.js';

// libs/portal — M3 PR-9 foundation slice. Hosts the two portal HTTP
// endpoints in a new lib; registered into apps/api's AppModule.
//
// Per directive §4.3 + Ruling 1: this is a controller-and-DTO-only lib.
// No prisma/, no PrismaService — all data access flows through
// TalentService (for /portal/profile) and ConsentService (for
// /portal/consent). The post-PR-17 uniform lazy-PrismaService substrate
// baseline is unchanged.
// PR-A1b §4 — EntitlementModule provides EntitlementGuard for the
// class-level @RequireCapability('portal') decorator. Tenant-axis gate
// (Ruling 1) — runs between JwtAuthGuard (AuthN) and RolesGuard (AuthZ).
@Module({
  imports: [AuthModule, TalentModule, ConsentModule, EntitlementModule],
  controllers: [PortalController],
})
export class PortalModule {}
