import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { CommunicationsRepository } from '@aramo/communications';
import { PipelineRepository, type PipelineView } from '@aramo/pipeline';

import type { TalentResponseChannel } from './dto/record-talent-response-request.dto.js';

export interface RecordTalentResponseResult {
  interaction_id: string;
  deduped: boolean;
  pipeline: PipelineView;
}

// Recruiting-Journey §7/§8/§16 — the composition-root orchestration for recording a
// recruiter-attested Talent response and advancing the milestone. apps/api is the
// composition root: it reads/acts into BOTH Communications (attested evidence) and
// Pipeline (milestone) without creating a libs/communications→pipeline edge. The FE
// never sets stage; this records durable evidence FIRST, then advances the milestone
// through the canonical evidence-bearing command (via reconcileForward).
@Injectable()
export class TalentResponseService {
  private readonly logger = new Logger(TalentResponseService.name);

  constructor(
    private readonly comms: CommunicationsRepository,
    private readonly pipelines: PipelineRepository,
  ) {}

  async recordResponse(args: {
    auth: AuthContextType;
    pipelineId: string;
    channel: TalentResponseChannel;
    occurredAt: Date;
    note?: string | null;
    idempotencyKey: string;
    requestId: string;
    visibleRequisitionIds: ReadonlySet<string> | null;
  }): Promise<RecordTalentResponseResult> {
    // 1) Resolve the bound pipeline tenant + visibility scoped. A non-visible or
    //    missing episode conceals as the SAME 404 (never leaked). Talent +
    //    Requisition are taken FROM the pipeline, never trusted from the body (§18).
    const pipeline = await this.pipelines.findByIdForActor({
      tenant_id: args.auth.tenant_id,
      id: args.pipelineId,
      visible_requisition_ids: args.visibleRequisitionIds,
    });
    if (pipeline === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Pipeline not found in tenant (or not visible to actor)',
        404,
        { requestId: args.requestId, details: { id: args.pipelineId } },
      );
    }

    // 2) 'other' channel requires a note (§6 cross-field rule).
    if (
      args.channel === 'other' &&
      (args.note === undefined || args.note === null || args.note.trim().length === 0)
    ) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'A note is required when the response channel is "other"',
        422,
        { requestId: args.requestId, details: { field: 'note' } },
      );
    }

    // 3) occurred_at rules: not in the future, and not before the first grounded
    //    OUTBOUND contact for THIS Talent × Requisition (watch-item #2 — scoped to
    //    the bound context, not any historical contact for the Talent).
    const now = new Date();
    if (args.occurredAt.getTime() > now.getTime()) {
      throw new AramoError('VALIDATION_ERROR', 'occurred_at cannot be in the future', 422, {
        requestId: args.requestId,
        details: { field: 'occurred_at' },
      });
    }
    const firstContactAt = await this.comms.findFirstOutboundContactInstant(
      args.auth.tenant_id,
      pipeline.talent_record_id,
      pipeline.requisition_id,
    );
    if (firstContactAt !== null && args.occurredAt.getTime() < firstContactAt.getTime()) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'occurred_at cannot precede the first recorded contact for this talent and requisition',
        422,
        {
          requestId: args.requestId,
          details: { field: 'occurred_at', first_contact_at: firstContactAt.toISOString() },
        },
      );
    }

    // 4) ATOMIC attested-evidence write (interaction + talent/req/pipeline
    //    associations + disposition, one transaction). Idempotent on the recorder
    //    key: a retried submit returns the existing interaction (deduped) with no
    //    second write; a genuinely separate response carries a distinct key and
    //    persists independently (watch-item #1 + #3).
    const { interaction_id, deduped } = await this.comms.recordAttestedResponse({
      tenant_id: args.auth.tenant_id,
      talent_record_id: pipeline.talent_record_id,
      requisition_id: pipeline.requisition_id,
      pipeline_id: pipeline.id,
      channel: args.channel,
      occurred_at: args.occurredAt,
      recorded_by_id: args.auth.sub,
      disposition: 'connected',
      note: args.note ?? null,
      idempotency_key: args.idempotencyKey,
    });

    // 5) Advance through the CANONICAL evidence-bearing path. reconcileForward walks
    //    FORWARD through the ordered milestones (no_contact→contacted→talent_responded)
    //    grounding each hop on THIS response evidence (§8 — a response proves contact
    //    occurred). IDEMPOTENT (already at/past target → no-op, so a retry adds no
    //    transition), CAS-protected, forward-only. A stale-journey CAS conflict
    //    surfaces as 409 for the FE's "journey changed" path (§10); the evidence is
    //    already durable, so a retry (same key) dedupes then re-reconciles.
    const advanced = await this.pipelines.reconcileForward({
      tenant_id: args.auth.tenant_id,
      id: pipeline.id,
      target: 'talent_responded',
      changed_by_id: args.auth.sub,
      requestId: args.requestId,
      visible_requisition_ids: args.visibleRequisitionIds,
      evidence: { kind: 'communication_interaction', id: interaction_id },
    });

    this.logger.log({
      event: 'talent_response_recorded',
      tenant_id: args.auth.tenant_id,
      pipeline_id: pipeline.id,
      interaction_id,
      deduped,
      to_status: advanced.status,
    });
    return { interaction_id, deduped, pipeline: advanced };
  }
}
