import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CompanyModule } from '@aramo/company';
import { ContactModule } from '@aramo/contact';
import { EntitlementModule } from '@aramo/entitlement';
import { RequisitionModule } from '@aramo/requisition';
import { TalentRecordModule } from '@aramo/talent-record';

import { PrismaService } from './prisma/prisma.service.js';
import { SavedListController } from './saved-list.controller.js';
import { SavedListRepository } from './saved-list.repository.js';

// SavedListModule — PR-A6 Gate 5+6 (combined) ATS finisher.
//
// Leaf import set (lint:nx-boundaries — directional edges only):
//   - AuthModule          → JwtAuthGuard
//   - AuthorizationModule → RolesGuard
//   - EntitlementModule   → EntitlementGuard
//   - CompanyModule       → CompanyRepository (typed-polymorphism owner check)
//   - ContactModule       → ContactRepository (typed-polymorphism owner check)
//   - RequisitionModule   → RequisitionRepository (typed-polymorphism owner check)
//   - TalentRecordModule  → TalentRecordRepository (typed-polymorphism owner check)
//
// All 4 cross-lib edges are forward (saved-list → entity); none of the
// 4 entity libs imports @aramo/saved-list — no cycle. This is the A4
// shape generalized: A4 imported only @aramo/talent-record (the lone
// live owner type at the time); A6 imports all 4 because the ATS
// substrate is complete.
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
  controllers: [SavedListController],
  providers: [PrismaService, SavedListRepository],
  exports: [SavedListRepository],
})
export class SavedListModule {}
