import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { RequisitionModule } from '@aramo/requisition';
import {
  FieldglassLifecycleSource,
  IntegrationModule,
  LifecycleSourceAdapterRegistry,
} from '@aramo/integration';

import { ExternalLifecycleReconciler } from './external-lifecycle-reconciler.js';
import { LifecycleIngressService } from './lifecycle-ingress.service.js';
import { LifecyclePollProducer } from './lifecycle-poll.producer.js';
import { RequisitionIdentityEstablishmentService } from './requisition-identity-establishment.service.js';
import { RequisitionReconciliationDrainService } from './reconciliation-drain.service.js';

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
    // CB-D2-R (ADR-0030) — the reconciliation-drain worker service (composes the
    // requisition command seam + the integration reconciliation queue). Provided
    // here so both the scheduled processor (ReconciliationDrainModule) and the
    // integration proof (drainBatch seam) resolve the same singleton.
    RequisitionReconciliationDrainService,
    {
      provide: 'ReconciliationDrainServiceLogger',
      useFactory: () => createAramoLogger(RequisitionReconciliationDrainService.name),
    },
  ],
  exports: [
    ExternalLifecycleReconciler,
    LifecycleIngressService,
    LifecyclePollProducer,
    RequisitionIdentityEstablishmentService,
    RequisitionReconciliationDrainService,
  ],
})
export class RequisitionIntegrationModule {
  // CB-D2-FG (seam #4) — register the FIRST real provider lifecycle source at the
  // composition root. The neutral LifecycleSourceAdapterRegistry ships EMPTY (A1);
  // Connector-B binds concrete provider adapters here, where the poll producer and
  // the registry meet, keeping libs/integration's registry vendor-free. The FG
  // source is dependency-free (it receives credential + config via the fetch
  // context), so it is constructed directly.
  constructor(private readonly sources: LifecycleSourceAdapterRegistry) {
    this.sources.register(new FieldglassLifecycleSource());
  }
}
