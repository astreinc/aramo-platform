import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import {
  DefinitionSetRepository,
  MaterializationIntentRepository,
  PrismaService as PreStartPrismaService,
  ReadinessDecisionRepository,
  RequirementInstanceRepository,
} from '@aramo/pre-start-requirement';
import { PlacementRepository, PrismaService as PlacementPrismaService } from '@aramo/placement';

import { PreStartRequirementController } from './pre-start-requirement.controller.js';
import { PlacementReadinessService } from './placement-readiness.service.js';
import { PreStartMaterializationService } from './pre-start-materialization.service.js';
import { PreStartWaiverService } from './pre-start-waiver.service.js';
import { PreStartCancellationService } from './pre-start-cancellation.service.js';
import { PlacementBlockReconciliationService } from './placement-block-reconciliation.service.js';
import { READINESS_EVALUATOR, RealReadinessEvaluator } from './readiness-evaluator.js';

// Track 3 / E2 — apps/api composition root. The readiness gate is the one place
// where @aramo/pre-start-requirement (the derivation) and @aramo/placement (the
// transition authority) are allowed to meet — the E2 LIB never imports placement.
//
// Both libs export a class named PrismaService; they are DISTINCT class objects
// (distinct DI tokens), so each repository binds to its own schema connection.
@Module({
  // The guarded controller lives in THIS sub-module (not AppModule), so the
  // guard-providing modules must be imported here for @UseGuards(JwtAuthGuard,
  // EntitlementGuard, RolesGuard) to resolve. Each is instantiated once app-wide.
  imports: [AuthModule, AuthorizationModule, EntitlementModule],
  controllers: [PreStartRequirementController],
  providers: [
    PreStartPrismaService,
    PlacementPrismaService,
    DefinitionSetRepository,
    RequirementInstanceRepository,
    MaterializationIntentRepository,
    ReadinessDecisionRepository,
    PlacementRepository,
    // §14 A2-R — production ALWAYS binds the real evaluator. Tests override this
    // token with a permissive double; there is no environment bypass.
    RealReadinessEvaluator,
    { provide: READINESS_EVALUATOR, useClass: RealReadinessEvaluator },
    PlacementReadinessService,
    PreStartMaterializationService,
    PreStartWaiverService,
    PreStartCancellationService,
    PlacementBlockReconciliationService,
  ],
  // L2-H — export the read repository so the Unified Talent Journey composer can read the
  // pre-start requirement instances for a placement (read-only; no command surface added).
  // L5-P1 — PreStartPrismaService is exported so the pre-start orchestrator worker
  // (a separate composition module) can bind it as the raw cross-schema reader via a
  // STRING token useExisting (ONE shared pooled client; no second bare-class provider,
  // avoiding the non-strict app.get lookup-collision trap).
  exports: [PlacementReadinessService, PreStartMaterializationService, PreStartCancellationService, RequirementInstanceRepository, PreStartPrismaService],
})
export class PreStartRequirementModule {}
