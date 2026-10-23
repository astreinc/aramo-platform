import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { ConsentModule } from '@aramo/consent';
import { EntitlementModule } from '@aramo/entitlement';
import { IdentityCoreModule } from '@aramo/identity';
import { TalentRecordModule } from '@aramo/talent-record';

import { PortalController } from './portal.controller.js';
import { PortalTalentResolverModule } from './portal-talent-resolver.module.js';

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
    // Portal P2 P2b (§PR-2 ruling 2) — TenantService for tenant_name enrichment.
    // libs/portal is scope:ats; @aramo/identity is scope:shared, so this edge is
    // boundary-legal (scope:ats MAY depend on scope:shared). IdentityCoreModule
    // exports TenantService; it is already in apps/api's graph, so no new app
    // wiring. NO prisma enters libs/portal — data still flows through services.
    IdentityCoreModule,
    // ATI-SEP-1 T10 WP4 (Addendum A4, GAP-PORTAL-ID-1) — the portal talent
    // resolver lives in its own module. The legacy OPEN-4 chain deps (PortalUser
    // cluster lookup + the trust-ledger index-ref graph) are retired; the
    // resolver currently resolves no talent (uniform 404 NOT_AVAILABLE).
    PortalTalentResolverModule,
  ],
  controllers: [PortalController],
  // ATI-SEP-1 T8 — the portal membership resolver, reused by the apps/api portal
  // identifier-verification route (Talent Intelligence path).
  exports: [PortalTalentResolverModule],
})
export class PortalModule {}
