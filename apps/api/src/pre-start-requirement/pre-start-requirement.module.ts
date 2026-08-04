import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import {
  DefinitionSetRepository,
  MaterializationIntentRepository,
  PrismaService as PreStartPrismaService,
  RequirementInstanceRepository,
} from '@aramo/pre-start-requirement';
import { PlacementRepository, PrismaService as PlacementPrismaService } from '@aramo/placement';

import { PreStartRequirementController } from './pre-start-requirement.controller.js';
import { PlacementReadinessService } from './placement-readiness.service.js';
import { PreStartMaterializationService } from './pre-start-materialization.service.js';
import { PreStartWaiverService } from './pre-start-waiver.service.js';
import { PreStartCancellationService } from './pre-start-cancellation.service.js';
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
    PlacementRepository,
    // §14 A2-R — production ALWAYS binds the real evaluator. Tests override this
    // token with a permissive double; there is no environment bypass.
    RealReadinessEvaluator,
    { provide: READINESS_EVALUATOR, useClass: RealReadinessEvaluator },
    PlacementReadinessService,
    PreStartMaterializationService,
    PreStartWaiverService,
    PreStartCancellationService,
  ],
  exports: [PlacementReadinessService, PreStartMaterializationService, PreStartCancellationService],
})
export class PreStartRequirementModule {}
