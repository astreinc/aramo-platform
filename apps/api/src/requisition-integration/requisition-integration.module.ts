import { Module } from '@nestjs/common';
import { RequisitionModule } from '@aramo/requisition';
import { IntegrationModule } from '@aramo/integration';

import { ExternalLifecycleReconciler } from './external-lifecycle-reconciler.js';

// L1-D1 (ADR-0030) — the composition seam binding the requisition governed
// command seam (RequisitionModule) to the integration external-lifecycle
// substrate (IntegrationModule). Lives in apps/api by ruling: the two libs stay
// ignorant of each other (no requisition<->integration lib edge); this app-level
// module is the ONLY place they meet. All scope:ats — no I15 relevance.
@Module({
  imports: [RequisitionModule, IntegrationModule],
  providers: [ExternalLifecycleReconciler],
  exports: [ExternalLifecycleReconciler],
})
export class RequisitionIntegrationModule {}
