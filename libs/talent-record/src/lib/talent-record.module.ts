import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';

import { PrismaService } from './prisma/prisma.service.js';
import { TalentRecordController } from './talent-record.controller.js';
import { TalentRecordRepository } from './talent-record.repository.js';

// TalentRecordModule — PR-A4 Gate 5 ATS Batch 3.
//
// Leaf import set (lint:nx-boundaries — no domain back-edges):
//   - AuthModule          → JwtAuthGuard
//   - AuthorizationModule → RolesGuard
//   - EntitlementModule   → EntitlementGuard
//
// Deliberately NOT imported: @aramo/talent (Core, the tenant-AGNOSTIC
// identity Talent + TalentTenantOverlay). The Core-Talent adapter is
// A5's responsibility per amendment §3 / §5; A4 is standalone.
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule],
  controllers: [TalentRecordController],
  providers: [PrismaService, TalentRecordRepository],
  exports: [TalentRecordRepository],
})
export class TalentRecordModule {}
