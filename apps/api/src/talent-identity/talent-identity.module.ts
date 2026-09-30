import { Module } from '@nestjs/common';
import { TalentTrustModule } from '@aramo/talent-trust';

import { DossierService } from './dossier.service.js';

// TalentIdentityModule — a thin composition module that provides + EXPORTS the
// DossierService so other apps/api read-composition modules (Talent 360) can
// reuse the authoritative trust dossier without re-deriving identity outcomes.
// It imports TalentTrustModule for DossierService's deps (TalentTrustService +
// TalentTrustRepository, both exported there). This does NOT change AppModule's
// own DossierService wiring (which serves DossierController in its own module
// scope) — the two module scopes each hold a stateless instance, so there is no
// cross-module bare-class lookup and no double-provide within a single scope.
@Module({
  imports: [TalentTrustModule],
  providers: [DossierService],
  exports: [DossierService],
})
export class TalentIdentityModule {}
