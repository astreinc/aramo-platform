import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CompanyModule } from '@aramo/company';
import { ContactModule } from '@aramo/contact';
import { EntitlementModule } from '@aramo/entitlement';
import { RequisitionModule } from '@aramo/requisition';
import { TalentRecordModule } from '@aramo/talent-record';

import { ImportController } from './import.controller.js';
import { ImportService } from './import.service.js';
import { PrismaService } from './prisma/prisma.service.js';

// ImportModule — PR-A8-1 Gate 5 (the import ENGINE).
//
// Leaf import set (lint:nx-boundaries — directional edges only):
//   - AuthModule          → JwtAuthGuard
//   - AuthorizationModule → RolesGuard
//   - EntitlementModule   → EntitlementGuard
//   - CompanyModule       → CompanyRepository.createForImport / deleteByImportBatch
//   - ContactModule       → ContactRepository.createForImport / deleteByImportBatch
//   - RequisitionModule   → RequisitionRepository.createForImport / deleteByImportBatch
//   - TalentRecordModule  → TalentRecordRepository.createForImport / deleteByImportBatch
//
// All 4 cross-lib edges are forward (import → target); none of the 4
// target libs imports @aramo/import — no cycle. This is the A6
// saved-list shape: the engine reaches forward to write its target's
// rows; the target lib remains ignorant of the engine.
//
// THE non-negotiable boundary (directive §0): @aramo/talent (the Core
// lib) is NOT imported here. Structural proof that the engine never
// crosses into Core. The integration spec asserts bit-identical
// talent.* row-counts pre/post.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    CompanyModule,
    ContactModule,
    RequisitionModule,
    TalentRecordModule,
  ],
  controllers: [ImportController],
  providers: [PrismaService, ImportService],
  exports: [ImportService],
})
export class ImportModule {}
