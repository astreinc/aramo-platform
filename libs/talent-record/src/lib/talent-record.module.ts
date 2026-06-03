import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { TalentModule } from '@aramo/talent';

import { PrismaService } from './prisma/prisma.service.js';
import { TalentRecordController } from './talent-record.controller.js';
import { TalentRecordRepository } from './talent-record.repository.js';
import { TalentLinkService } from './talent-link.service.js';

// TalentRecordModule — PR-A4 Gate 5 ATS Batch 3.
//
// Import set:
//   - AuthModule          → JwtAuthGuard
//   - AuthorizationModule → RolesGuard
//   - EntitlementModule   → EntitlementGuard
//   - TalentModule (PR-A5b-2) → TalentRepository (the in-tenant
//     validation gate for the Core-Talent link). DIRECTIONAL EDGE
//     ONLY — `talent` does NOT import `talent-record` (verified by
//     grep + lint:nx-boundaries). No cycle.
//
// PR-A5b-2 fills the deferred attach point that this lib's prior doc-
// comment promised — "the Core-Talent adapter is A5's responsibility
// per amendment §3 / §5". TalentLinkService is that adapter; it
// composes TalentRecordRepository (the ATS-side write) with
// TalentRepository (the Core-side read-only validation).
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule, TalentModule],
  controllers: [TalentRecordController],
  providers: [PrismaService, TalentRecordRepository, TalentLinkService],
  exports: [TalentRecordRepository, TalentLinkService],
})
export class TalentRecordModule {}
