import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { QUALIFIED_TRANSITION_GUARD, type QualifiedTransitionGuardPort } from '@aramo/pipeline';

import { DocumentReadinessGate } from './document-readiness.gate.js';
import { DocumentReadinessModule } from './document-readiness.module.js';

// DOC-TEMPLATE-ADMIN-RTR-1 (§29-32) — the composition-root adapter for the Pipeline
// QUALIFIED_TRANSITION_GUARD port. This is the ONLY place the (scope:ats) recruiting
// `qualified` milestone is joined to the ATS/Documents RTR readiness predicate
// (ADR-0029 Pipeline⊥ATS wall): libs/pipeline depends solely on the port interface.
// It REUSES DocumentReadinessGate.assess — the same CONDITIONAL same-document executed-
// RTR predicate that gates the ATS submit path — so the board, the drawer, the submit
// gate, and the qualify gate all agree on a single source of RTR truth. The caller
// (PipelineRepository) passes the exact (talent, requisition) from the row it already
// loaded, so this adapter needs NO Pipeline read — avoiding a DI cycle. @Global so the
// PipelineRepository (in its own module) can inject the STRING token.
@Injectable()
export class RtrQualifiedTransitionGuard implements QualifiedTransitionGuardPort {
  constructor(@Inject(DocumentReadinessGate) private readonly readiness: DocumentReadinessGate) {}

  async assertCanQualify(input: {
    tenant_id: string;
    talent_id: string;
    requisition_id: string;
    requestId: string;
  }): Promise<void> {
    // CONDITIONAL (§30): ungated unless an RTR requirement exists for the requisition;
    // when required, satisfied ONLY by an EXECUTED RTR for the exact (talent, requisition).
    const verdict = await this.readiness.assess({
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      requisition_id: input.requisition_id,
    });
    if (verdict.satisfied) return;

    throw new AramoError(
      'PIPELINE_QUALIFY_REQUIRES_RTR',
      'This talent cannot be marked Qualified until an executed Right to Represent exists for this requisition.',
      422,
      {
        requestId: input.requestId,
        details: { talent_id: input.talent_id, requisition_id: input.requisition_id },
      },
    );
  }
}

@Global()
@Module({
  imports: [DocumentReadinessModule],
  providers: [
    RtrQualifiedTransitionGuard,
    { provide: QUALIFIED_TRANSITION_GUARD, useExisting: RtrQualifiedTransitionGuard },
  ],
  exports: [QUALIFIED_TRANSITION_GUARD],
})
export class RtrQualifiedTransitionGuardModule {}
