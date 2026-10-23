import { Module } from '@nestjs/common';
import { EntitlementModule } from '@aramo/entitlement';
import { IntelligenceIntegrationModule } from '@aramo/intelligence-integration';

import { DossierService } from './dossier.service.js';
import { IntelligenceAccess } from './intelligence-access.js';

// TalentIdentityModule — a thin composition module that provides + EXPORTS the
// DossierService (and the fail-soft IntelligenceAccess gate it reads through) so
// the apps/api read compositions (Talent 360, the TIP read seam) and the
// recruiter trust surfaces share ONE presentation of Talent Intelligence's view.
// ATI-SEP-1 T10 WP3b: the dossier reads TI over HTTP (IntelligenceIntegrationModule
// → IntelligenceClient); the legacy trust-ledger dependency is gone.
@Module({
  imports: [EntitlementModule, IntelligenceIntegrationModule],
  providers: [IntelligenceAccess, DossierService],
  exports: [IntelligenceAccess, DossierService],
})
export class TalentIdentityModule {}
