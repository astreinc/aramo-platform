import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  QUALIFIED_TRANSITION_GUARD,
  type QualifiedGuardTx,
  type QualifiedRtrDecision,
  type QualifiedTransitionGuardPort,
} from '@aramo/pipeline';

import { acquireCspReadLock, readDatabaseClock } from '../client-submittal-policy/csp-linearization.js';

import { DocumentReadinessGate } from './document-readiness.gate.js';
import { DocumentReadinessModule } from './document-readiness.module.js';

// DOC-TEMPLATE-ADMIN-RTR-1 (§29-32) — the composition-root adapter for the Pipeline
// QUALIFIED_TRANSITION_GUARD port. This is the ONLY place the (scope:ats) recruiting
// `qualified` milestone is joined to the ATS/Documents RTR readiness predicate
// (ADR-0029 Pipeline⊥ATS wall): libs/pipeline depends solely on the port interface.
// It REUSES DocumentReadinessGate — the same effective-policy interpretation that gates
// the ATS submit path — so the board, the drawer, the submit gate, and the qualify gate
// all agree on a single source of RTR truth. @Global so the PipelineRepository (in its
// own module) can inject the STRING token.
//
// Talent Lifecycle R1–R5 Impl Directive v1.2 §4.3/§4.4: runs on the Pipeline transition's
// OWN transaction — the shared client-submittal-policy lock first, then (after the CAS)
// the linearization instant t_L, the policy resolved at t_L, and the executed RTR locked
// FOR SHARE. UNRESOLVED refuses (A1 AM-6 §7.3); it is never treated as "not required".
@Injectable()
export class RtrQualifiedTransitionGuard implements QualifiedTransitionGuardPort {
  constructor(@Inject(DocumentReadinessGate) private readonly readiness: DocumentReadinessGate) {}

  async beginQualifyInTx(tx: QualifiedGuardTx, input: { tenant_id: string }): Promise<void> {
    await acquireCspReadLock(tx, input.tenant_id);
  }

  async assertCanQualifyInTx(
    tx: QualifiedGuardTx,
    input: { tenant_id: string; talent_id: string; requisition_id: string; requestId: string },
  ): Promise<QualifiedRtrDecision> {
    const at = await readDatabaseClock(tx);
    const { verdict, policy } = await this.readiness.assessInTx(tx, {
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      requisition_id: input.requisition_id,
      at,
    });
    if (policy.disposition === 'UNRESOLVED') {
      throw new AramoError(
        'PIPELINE_QUALIFY_RTR_POLICY_UNRESOLVED',
        'This talent cannot be marked Qualified: the Right to Represent policy is not set for this client.',
        422,
        {
          requestId: input.requestId,
          details: {
            talent_id: input.talent_id,
            requisition_id: input.requisition_id,
            reason: policy.unresolved_reason === 'NO_KEY' ? 'rtr_requirement_not_declared' : 'no_policy_layer',
          },
        },
      );
    }
    if (!verdict.satisfied) {
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
    return {
      disposition: policy.disposition,
      source: policy.source,
      scope_ref: policy.scope_ref,
      version: policy.version,
      checksum: policy.checksum,
      composite_version: policy.composite_version,
      resolved_at: policy.resolved_at,
    };
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
