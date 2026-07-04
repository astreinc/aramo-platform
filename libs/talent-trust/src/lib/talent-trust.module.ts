import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { SubjectMatcherService } from './subject-matcher.service.js';
import { SubjectResolutionService } from './subject-resolution.service.js';
import { TalentTrustRepository } from './talent-trust.repository.js';
import { TalentTrustService } from './talent-trust.service.js';

// libs/talent-trust module — TR-1 (Trust Model & Vocabulary, foundation
// slice). Wires the talent-trust-owned PrismaService, the ledger repository,
// and the TalentTrustService (the §8 interface — the only public surface).
//
// TR-1 adds NO controller, NO HTTP endpoint, NO Pact surface (backend-only,
// no FE — directive §3). Downstream slices (TR-2…TR-10 producers; TR-12/14
// readers) import @aramo/talent-trust and call TalentTrustService. Out of
// scope per directive §9: verification execution, sufficiency/gating, merge
// decision logic (TR-6 supplies the when), the cross-tenant path (TR-11), and
// any client dossier view (TR-14).
@Module({
  providers: [
    PrismaService,
    TalentTrustRepository,
    TalentTrustService,
    SubjectMatcherService,
    SubjectResolutionService,
  ],
  exports: [
    TalentTrustService,
    TalentTrustRepository,
    SubjectMatcherService,
    SubjectResolutionService,
  ],
})
export class TalentTrustModule {}
