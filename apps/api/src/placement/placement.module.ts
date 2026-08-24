import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import {
  PolicyStore,
  PrismaService as PolicyStorePrismaService,
} from '@aramo/policy-store';
import {
  CommercialApprovalPolicyService,
  COMMERCIAL_APPROVAL_POLICY_STORE,
  GuaranteeTermRepository,
  PermanentPlacementRepository,
  PlacementProcessEventRepository,
  PlacementRepository,
  PrismaService,
} from '@aramo/placement';

import { PlacementController } from './placement.controller.js';
import { GuaranteeTermsController } from './guarantee-terms.controller.js';

// Track 3 / E1-b — apps/api composition root for the PlacementProcess HTTP
// surface. The guarded controller lives in THIS sub-module, so the guard-
// providing modules must be imported here for @UseGuards(JwtAuthGuard,
// EntitlementGuard, RolesGuard) to resolve (each is instantiated once app-wide).
//
// Slice #4 — Commercial Approval (R-POLICY): PlacementRepository's optional
// commercial-approval gate is provided here. Its PolicyStore is under the
// DEDICATED COMMERCIAL_APPROVAL_POLICY_STORE token — NOT the bare `PolicyStore`
// class — so it does NOT join the class-token instance list that
// `app.get(PolicyStore, { strict: false })` resolves through (the Offer/add-talent
// lesson: a bare third provider shifts that resolution).
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule],
  controllers: [PlacementController, GuaranteeTermsController],
  providers: [
    PrismaService,
    PolicyStorePrismaService,
    { provide: COMMERCIAL_APPROVAL_POLICY_STORE, useClass: PolicyStore },
    CommercialApprovalPolicyService,
    PlacementRepository,
    PlacementProcessEventRepository,
    PermanentPlacementRepository,
    GuaranteeTermRepository,
  ],
  exports: [PlacementRepository],
})
export class PlacementModule {}
