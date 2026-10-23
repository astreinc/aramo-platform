import { Module } from '@nestjs/common';

import { EntitlementService } from './access/entitlement.service.js';
import { ProfileReadService } from './access/profile-read.service.js';
import { ServiceTokenService } from './auth/service-token.service.js';
import { IdentityMergeSplitService } from './identity/merge-split.service.js';
import { IdentityResolutionService } from './identity/identity-resolution.service.js';
import { GOV_ID_TOKENIZER, TalentIngestService } from './ingest/talent-ingest.service.js';
import { IntelligenceHealthService } from './intelligence-health.service.js';
import { GovIdTokenizer } from './normalize.js';
import { FetchWebhookTransport, IntelligenceOutboxDrainService, WEBHOOK_TRANSPORT } from './outbox/outbox-drain.service.js';
import { PROJECTION_TRIGGER, ProjectionService } from './projection/projection.service.js';
import { VERIFICATION_CODE_SERVICE, VerificationCodeService } from './verification/verification-code.js';
import { VerificationDeliveryModule } from './verification/mailer-verification-delivery.js';
import { VerificationService } from './verification/verification.service.js';
import { VerificationStatusService } from './verification/verification-status.service.js';
import { ContradictionResolutionService } from './lifecycle/contradiction-resolution.service.js';
import { DisputeService } from './lifecycle/dispute.service.js';
import { ProposalService } from './lifecycle/proposal.service.js';
import { IntelligencePrismaService } from './prisma/intelligence-prisma.service.js';
import { PrismaIntelligenceUnitOfWork } from './repositories/prisma-unit-of-work.js';
import { INTELLIGENCE_UNIT_OF_WORK } from './repositories/types.js';

// ATI-SEP-1 — the Talent Intelligence core module (scope:intelligence).
// Depends only on scope:intelligence + scope:shared (eslint depConstraints).
// T0: Prisma + health. T1: repositories / unit of work. T2: ingestion + service
// tokens. T3: identity resolution + merge / split. T4: verification (+ delivery
// port; T8: @aramo/mailer adapter when MAILER_PROVIDER is set, else LOG). T5: projection / trust (post-commit trigger).
// T6: read API + entitlement sync. T7: outbox drain (webhook fan-out).
// T10: evidence lifecycle — disputes, proposals, contradiction resolution, verification status.
@Module({
  // T8 — VERIFICATION_DELIVERY_PORT: the @aramo/mailer adapter when
  // MAILER_PROVIDER is set in the TI process, else the LOG adapter.
  imports: [VerificationDeliveryModule],
  providers: [
    IntelligencePrismaService,
    IntelligenceHealthService,
    { provide: INTELLIGENCE_UNIT_OF_WORK, useClass: PrismaIntelligenceUnitOfWork },
    { provide: GOV_ID_TOKENIZER, useFactory: () => GovIdTokenizer.fromEnv() },
    IdentityResolutionService,
    IdentityMergeSplitService,
    TalentIngestService,
    ServiceTokenService,
    ProjectionService,
    { provide: PROJECTION_TRIGGER, useExisting: ProjectionService },
    { provide: VERIFICATION_CODE_SERVICE, useFactory: () => VerificationCodeService.fromEnv() },
    { provide: WEBHOOK_TRANSPORT, useClass: FetchWebhookTransport },
    VerificationService,
    ProfileReadService,
    EntitlementService,
    IntelligenceOutboxDrainService,
    VerificationStatusService,
    DisputeService,
    ProposalService,
    ContradictionResolutionService,
  ],
  exports: [
    IntelligencePrismaService,
    IntelligenceHealthService,
    INTELLIGENCE_UNIT_OF_WORK,
    IdentityResolutionService,
    IdentityMergeSplitService,
    TalentIngestService,
    ServiceTokenService,
    ProjectionService,
    PROJECTION_TRIGGER,
    VERIFICATION_CODE_SERVICE,
    VerificationDeliveryModule,
    WEBHOOK_TRANSPORT,
    VerificationService,
    ProfileReadService,
    EntitlementService,
    IntelligenceOutboxDrainService,
    VerificationStatusService,
    DisputeService,
    ProposalService,
    ContradictionResolutionService,
  ],
})
export class IntelligenceCoreModule {}
