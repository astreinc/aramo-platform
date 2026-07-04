import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { SourcedTalentRepository } from './sourced-talent.repository.js';

// libs/sourced-talent module — Fix-Slice-1 (Staging Front Door). Wires the
// sourced-talent-owned PrismaService and the L1 arrival-store repository.
//
// SCOPE (Fix-Slice-1): substrate only — NO controller, NO HTTP endpoint, NO
// Pact surface, NO sourcing-service write path, NO promotion/resolver wiring
// (that is fix-slice-2). Downstream (the Sourcing Service / canonicalization
// re-route) imports @aramo/sourced-talent and calls SourcedTalentRepository.
@Module({
  providers: [PrismaService, SourcedTalentRepository],
  exports: [SourcedTalentRepository],
})
export class SourcedTalentModule {}
