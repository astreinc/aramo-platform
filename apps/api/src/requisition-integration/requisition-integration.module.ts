import { Module } from '@nestjs/common';
import { RequisitionModule } from '@aramo/requisition';
import { IntegrationModule } from '@aramo/integration';

import { ExternalLifecycleReconciler } from './external-lifecycle-reconciler.js';
import { LifecycleIngressService } from './lifecycle-ingress.service.js';
import { LifecyclePollProducer } from './lifecycle-poll.producer.js';
import { RequisitionIdentityEstablishmentService } from './requisition-identity-establishment.service.js';

// L1-D1 (ADR-0030) — the composition seam binding the requisition governed
// command seam (RequisitionModule) to the integration external-lifecycle
// substrate (IntegrationModule). Lives in apps/api by ruling: the two libs stay
// ignorant of each other (no requisition<->integration lib edge); this app-level
// module is the ONLY place they meet. All scope:ats — no I15 relevance.
//
// CB-D2-A1 extends this seam with the provider-NEUTRAL lifecycle ingress:
//   - LifecycleIngressService — observation/event → ledger dedup → identity
//     resolve → ordering → the reconciler (reuse, never fork);
//   - RequisitionIdentityEstablishmentService — the idempotent post-establishment
//     handoff that records the connection-scoped identity at import success;
//   - LifecyclePollProducer — the scheduled poll → raw-persist → ingress →
//     cursor-advance producer (driven by the apps/api lifecycle-poll worker).
@Module({
  imports: [RequisitionModule, IntegrationModule],
  providers: [
    ExternalLifecycleReconciler,
    LifecycleIngressService,
    LifecyclePollProducer,
    RequisitionIdentityEstablishmentService,
  ],
  exports: [
    ExternalLifecycleReconciler,
    LifecycleIngressService,
    LifecyclePollProducer,
    RequisitionIdentityEstablishmentService,
  ],
})
export class RequisitionIntegrationModule {}
