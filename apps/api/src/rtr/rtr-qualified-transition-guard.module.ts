import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { PipelineModule, PipelineRepository, QUALIFIED_TRANSITION_GUARD, type QualifiedTransitionGuardPort } from '@aramo/pipeline';

import { DocumentReadinessGate } from './document-readiness.gate.js';
import { DocumentReadinessModule } from './document-readiness.module.js';

// DOC-TEMPLATE-ADMIN-RTR-1 (§29-32) — the composition-root adapter for the Pipeline
// QUALIFIED_TRANSITION_GUARD port. This is the ONLY place the (scope:ats) recruiting
// `qualified` milestone is joined to the ATS/Documents RTR readiness predicate
// (ADR-0029 Pipeline⊥ATS wall): libs/pipeline depends solely on the port interface.
// It REUSES DocumentReadinessGate.assess — the same CONDITIONAL same-document executed-
// RTR predicate that gates the ATS submit path — so the board, the drawer, the submit
// gate, and the qualify gate all agree on a single source of RTR truth. @Global so the
// PipelineController (in its own module) can inject the STRING token.
@Injectable()
export class RtrQualifiedTransitionGuard implements QualifiedTransitionGuardPort {
  constructor(
    private readonly pipelines: PipelineRepository,
    @Inject(DocumentReadinessGate) private readonly readiness: DocumentReadinessGate,
  ) {}

  async assertCanQualify(input: { tenant_id: string; pipeline_id: string; requestId: string }): Promise<void> {
    // Resolve the exact (talent, requisition) for this pipeline. A missing/invisible
    // row is a no-op here — the repository transition conceals it as 404 immediately
    // after this guard returns (never leak existence through the gate).
    const pipeline = await this.pipelines.findById({ tenant_id: input.tenant_id, id: input.pipeline_id });
    if (pipeline === null) return;

    // CONDITIONAL (§30): ungated unless an RTR requirement exists for the requisition;
    // when required, satisfied ONLY by an EXECUTED RTR for the exact (talent, requisition).
    const verdict = await this.readiness.assess({
      tenant_id: input.tenant_id,
      talent_id: pipeline.talent_record_id,
      requisition_id: pipeline.requisition_id,
    });
    if (verdict.satisfied) return;

    throw new AramoError(
      'PIPELINE_QUALIFY_REQUIRES_RTR',
      'This talent cannot be marked Qualified until an executed Right to Represent exists for this requisition.',
      422,
      {
        requestId: input.requestId,
        details: { pipeline_id: input.pipeline_id, requisition_id: pipeline.requisition_id },
      },
    );
  }
}

@Global()
@Module({
  imports: [PipelineModule, DocumentReadinessModule],
  providers: [
    RtrQualifiedTransitionGuard,
    { provide: QUALIFIED_TRANSITION_GUARD, useExisting: RtrQualifiedTransitionGuard },
  ],
  exports: [QUALIFIED_TRANSITION_GUARD],
})
export class RtrQualifiedTransitionGuardModule {}
