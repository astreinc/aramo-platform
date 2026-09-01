import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import {
  PolicyStore,
  PrismaService as PolicyStorePrismaService,
} from '@aramo/policy-store';
import {
  OfferRepository,
  OfferTransitionPolicyService,
  OFFER_POLICY_STORE,
  PrismaService,
} from '@aramo/placement';

import { OfferController } from './offer.controller.js';
import { OfferClientSelectionGate } from './offer-client-selection-gate.service.js';

// Offer Lifecycle (D5) — apps/api composition root for the /v1/offers surface.
// The offer transition gate is ADR-0024-governed via the (own generated client,
// lazy DATABASE_URL) PolicyStore, fail-closed on no published package. The store
// is provided under the DEDICATED OFFER_POLICY_STORE token — NOT the bare
// `PolicyStore` class — so it does NOT join the class-token instance list that
// `app.get(PolicyStore, { strict: false })` resolves through (pipeline's
// add-talent gate + requisition's transition gate own their own class-token
// PolicyStore singletons; a third bare one shifts that resolution and breaks the
// add-talent version-pinning invariant). Leaf import set (guards only) keeps
// lint:nx-boundaries acyclic.
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule],
  controllers: [OfferController],
  providers: [
    PrismaService,
    PolicyStorePrismaService,
    { provide: OFFER_POLICY_STORE, useClass: PolicyStore },
    OfferTransitionPolicyService,
    OfferRepository,
    // L3-E — SELECTED→Offer authorization gate. Reads the client_selection schema over
    // the placement connection (one DB, many schemas) via parameterized raw SQL, so the
    // Offer aggregate never couples to @aramo/client-selection.
    { provide: 'OfferGateDb', useExisting: PrismaService },
    OfferClientSelectionGate,
  ],
  exports: [OfferRepository],
})
export class OfferModule {}
