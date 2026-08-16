import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { GuaranteeTermRepository, PermanentPlacementRepository, PlacementProcessEventRepository, PlacementRepository, PrismaService } from '@aramo/placement';

import { PlacementController } from './placement.controller.js';
import { GuaranteeTermsController } from './guarantee-terms.controller.js';

// Track 3 / E1-b — apps/api composition root for the PlacementProcess HTTP
// surface. The guarded controller lives in THIS sub-module, so the guard-
// providing modules must be imported here for @UseGuards(JwtAuthGuard,
// EntitlementGuard, RolesGuard) to resolve (each is instantiated once app-wide).
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule],
  controllers: [PlacementController, GuaranteeTermsController],
  providers: [PrismaService, PlacementRepository, PlacementProcessEventRepository, PermanentPlacementRepository, GuaranteeTermRepository],
  exports: [PlacementRepository],
})
export class PlacementModule {}
