import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { ConsentModule } from '@aramo/consent';
import { EntitlementModule } from '@aramo/entitlement';
import { TalentRecordModule } from '@aramo/talent-record';
import { PortalIdentityModule } from '@aramo/portal-identity';
import { TalentTrustModule } from '@aramo/talent-trust';

import { PortalController } from './portal.controller.js';
import { PortalTalentResolverService } from './portal-talent-resolver.service.js';

// libs/portal — M3 PR-9 foundation slice. Hosts the two portal HTTP
// endpoints in a new lib; registered into apps/api's AppModule.
//
// Per directive §4.3 + Ruling 1: this is a controller-and-DTO-only lib.
// No prisma/, no PrismaService — all data access flows through
// TalentRecordService (for /portal/profile — 4e-rest-b re-home off Core
// onto the TalentRecord heart) and ConsentService (for /portal/consent).
// The post-PR-17 uniform lazy-PrismaService substrate baseline is unchanged.
// PR-A1b §4 — EntitlementModule provides EntitlementGuard for the
// class-level @RequireCapability('portal') decorator. Tenant-axis gate
// (Ruling 1) — runs between JwtAuthGuard (AuthN) and RolesGuard (AuthZ).
@Module({
  imports: [
    AuthModule,
    TalentRecordModule,
    ConsentModule,
    EntitlementModule,
    // Portal P1 PR-2a — the OPEN-4 chain deps: PortalUser lookup (sub → cluster)
    // + the platform-rail index-ref graph (cluster → subjects → ATS refs). Still
    // no prisma in libs/portal; all data access flows through injected services.
    PortalIdentityModule,
    TalentTrustModule,
  ],
  controllers: [PortalController],
  providers: [PortalTalentResolverService],
})
export class PortalModule {}
