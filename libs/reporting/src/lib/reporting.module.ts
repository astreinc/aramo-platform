import { Module } from '@nestjs/common';
import { ActivityModule } from '@aramo/activity';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CalendarModule } from '@aramo/calendar';
import { CompanyModule } from '@aramo/company';
import { ContactModule } from '@aramo/contact';
import { EntitlementModule } from '@aramo/entitlement';
import { PipelineModule } from '@aramo/pipeline';
import { RequisitionModule } from '@aramo/requisition';
import { SavedListModule } from '@aramo/saved-list';
import { SettingsModule } from '@aramo/settings';
import { TalentRecordModule } from '@aramo/talent-record';

import { DashboardController } from './dashboard.controller.js';
import { ReportingController } from './reporting.controller.js';
import { ReportingService } from './reporting.service.js';

// ReportingModule — PR-A7 Gate 5 — ATS-INTERNAL read aggregator.
//
// === Leaf import set (lint:nx-boundaries) ===
//
// Reads-only over the 8 ATS-side domains:
//   - AuthModule          → JwtAuthGuard
//   - AuthorizationModule → RolesGuard
//   - EntitlementModule   → EntitlementGuard
//   - CompanyModule       → CompanyRepository.count
//   - ContactModule       → ContactRepository.count
//   - TalentRecordModule  → TalentRecordRepository.count
//   - SavedListModule     → SavedListRepository.count
//   - CalendarModule      → CalendarRepository.count / list
//   - ActivityModule      → ActivityRepository.count / list
//   - RequisitionModule   → countForActor / countByStatusForActor (A3)
//   - PipelineModule      → count / countByStatus
//
// === Seam-exclusion (structural) ===
//
// This module imports ZERO Core / engagement / submittal / examination
// / matching / talent / job_domain modules. The dependency closure
// here is the proof: A7 reads no Core schema. The integration spec
// asserts this structurally (by NOT applying any Core/engagement/
// submittal migration to the test container — the routes still serve
// every metric, because none touches a Core table).
//
// SettingsModule is tenant-CONFIG (the settings schema), NOT Core — the
// recruiter-metrics route reads the tenant-default KPI goals from it. The
// Core seam-exclusion is unchanged (no engagement/submittal/examination).
//
// All 8 entity-module edges are FORWARD (reporting → entity); no
// entity module imports @aramo/reporting → no cycle.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    ActivityModule,
    CalendarModule,
    CompanyModule,
    ContactModule,
    PipelineModule,
    RequisitionModule,
    SavedListModule,
    SettingsModule,
    TalentRecordModule,
  ],
  controllers: [ReportingController, DashboardController],
  providers: [ReportingService],
  exports: [ReportingService],
})
export class ReportingModule {}
