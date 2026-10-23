import { Module } from '@nestjs/common';

import { PortalTalentResolverService } from './portal-talent-resolver.service.js';

// ATI-SEP-1 T10 WP4 — the portal talent resolver in its own module. Under
// Addendum A4 (GAP-PORTAL-ID-1) it has NO dependencies: the trust-ledger /
// identity-index chain is retired and the resolver answers "no resolvable
// talent" (see PortalTalentResolverService). The Portal identity increment
// replaces the implementation here, in one place.
@Module({
  providers: [PortalTalentResolverService],
  exports: [PortalTalentResolverService],
})
export class PortalTalentResolverModule {}
