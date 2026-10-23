import { Module } from '@nestjs/common';
import { PortalIdentityModule } from '@aramo/portal-identity';
import { TalentTrustModule } from '@aramo/talent-trust';

import { PortalTalentResolverService } from './portal-talent-resolver.service.js';

// ATI-SEP-1 T10 WP3b — the OPEN-4 membership chain in its own module. The
// PortalController no longer reads the trust ledger (its verification + dispute
// routes answer NOT_AVAILABLE under Addendum A4); the ONLY remaining libs/portal
// edge to @aramo/talent-trust is this resolver's (sub → cluster → subjects → ATS
// refs). It is isolated here so the portal identity re-point (WP4) replaces it in
// one place.
@Module({
  imports: [PortalIdentityModule, TalentTrustModule],
  providers: [PortalTalentResolverService],
  exports: [PortalTalentResolverService],
})
export class PortalTalentResolverModule {}
