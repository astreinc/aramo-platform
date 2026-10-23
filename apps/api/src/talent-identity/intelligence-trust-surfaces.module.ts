import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { ConsentModule } from '@aramo/consent';
import { EntitlementModule } from '@aramo/entitlement';
import { IntelligenceIntegrationModule } from '@aramo/intelligence-integration';
import { TalentRecordModule } from '@aramo/talent-record';

import { PublicVerificationController, VerificationConfirmBudget } from '../controllers/public-verification.controller.js';

import { ContradictionResolutionController } from './contradiction-resolution.controller.js';
import { DossierController } from './dossier.controller.js';
import { EmailVerificationController } from './email-verification.controller.js';
import { EmailVerificationService } from './email-verification.service.js';
import { PortalDisputeDispositionController } from './portal-dispute-disposition.controller.js';
import { TalentIdentityModule } from './talent-identity.module.js';
import { VerificationProposalController } from './verification-proposal.controller.js';

// ATI-SEP-1 T10 WP3b — the recruiter trust surfaces, re-pointed onto Talent
// Intelligence (TI owns trust; Addendum A3 T10-2 / T10-3). Every member reaches
// TI ONLY through IntelligenceClient (HTTP + @aramo/intelligence-contracts) and
// fails soft: the ATS works with TI unconfigured, the tenant unentitled, or TI
// down. Routes (paths unchanged from the legacy surfaces):
//   GET  /v1/talent-records/:id/dossier[/evidence]                 (ats · talent:read)
//   GET|POST /v1/talent/identity/proposals[/:id/{dismiss,act}]     (ats · talent:read)
//   POST /v1/talent/identity/contradictions/:assertionId/resolve   (core · identity:resolve)
//   GET|POST /v1/talent/identity/portal-disputes[/:id[/…]]         (core · identity:resolve)
//   GET|POST /v1/talent-records/:recordId/email-verifications      (ats · talent:read / talent:edit)
//   POST /v1/email-verifications/confirm                           (PZ · public, per-IP budget)
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    TalentRecordModule,
    ConsentModule,
    IntelligenceIntegrationModule,
    TalentIdentityModule,
  ],
  controllers: [
    DossierController,
    VerificationProposalController,
    ContradictionResolutionController,
    PortalDisputeDispositionController,
    EmailVerificationController,
    PublicVerificationController,
  ],
  providers: [EmailVerificationService, VerificationConfirmBudget],
  exports: [VerificationConfirmBudget],
})
export class IntelligenceTrustSurfacesModule {}
