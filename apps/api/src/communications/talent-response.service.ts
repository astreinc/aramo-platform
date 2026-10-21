import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { CommunicationsRepository } from '@aramo/communications';
import { PipelineRepository, isTerminalRequisitionStatus, requisitionPermits, type PipelineView } from '@aramo/pipeline';
import { RequisitionRepository } from '@aramo/requisition';

import type { TalentResponseChannel } from './dto/record-talent-response-request.dto.js';

export interface RecordTalentResponseResult {
  interaction_id: string;
  deduped: boolean;
  pipeline: PipelineView;
  // Talent Lifecycle R1–R5 Impl Directive v1.2 §7.4/§7.5 (S4) — the accountable record: whether
  // the milestone advanced, WHEN the response occurred, WHEN it was recorded, and WHO recorded it.
  advanced: boolean;
  occurred_at: Date;
  recorded_at: Date;
  recorded_by_id: string;
}

// v1.2 §7.4 safeguard 2 — a source interaction whose LATEST outcome is one of these is not a
// substantive Talent response; confirming it is refused (`connected` / `completed` alone are
// connection facts, never by themselves a response — A1 §5.1).
export const NON_SUBSTANTIVE_SOURCE_DISPOSITIONS: readonly string[] = [
  'callback_requested',
  'follow_up_required',
  'no_answer',
  'left_voicemail',
  'busy',
  'wrong_number',
  'do_not_contact',
];

// Recruiting-Journey §7/§8/§16 + Talent Lifecycle R1–R5 Implementation Directive v1.2 §7.4/§7.5
// (S4, A1 AM-4) — the RECRUITER-CONFIRMED "Talent responded" command. apps/api is the
// composition root: it reads/acts into Communications (the confirmation record), Requisition
// (the status + closing instant) and Pipeline (the milestone) without a lib→lib edge. The FE
// never sets stage. A recruiter (a user principal — never a system, service or connector)
// attests a SUBSTANTIVE response AND grounds it on either a verified source interaction or an
// attributable note; the confirmation is recorded durably FIRST, then the milestone advances
// through reconcileForward (ALL hops in one transaction, the evidence verified in-transaction).
@Injectable()
export class TalentResponseService {
  private readonly logger = new Logger(TalentResponseService.name);

  constructor(
    private readonly comms: CommunicationsRepository,
    private readonly pipelines: PipelineRepository,
    private readonly requisitions: RequisitionRepository,
  ) {}

  async recordResponse(args: {
    auth: AuthContextType;
    pipelineId: string;
    channel: TalentResponseChannel;
    occurredAt: Date;
    note?: string | null;
    substantiveResponseAttested?: boolean;
    sourceInteractionId?: string | null;
    idempotencyKey: string;
    requestId: string;
    visibleRequisitionIds: ReadonlySet<string> | null;
  }): Promise<RecordTalentResponseResult> {
    // 0) v1.2 §7.4 — the principal: a recruiter USER only. A system, service-account or
    //    connector principal never confirms a Talent response.
    if (args.auth.actor_kind !== 'user' || args.auth.consumer_type !== 'recruiter') {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'Only a recruiter can confirm a Talent response',
        403,
        { requestId: args.requestId, details: { reason: 'recruiter_user_required' } },
      );
    }

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

    // 2) v1.2 §7.4 — the attestation is REQUIRED and is the literal true.
    if (args.substantiveResponseAttested !== true) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Confirm that the Talent gave a substantive response',
        422,
        { requestId: args.requestId, details: { field: 'substantive_response_attested', reason: 'attestation_required' } },
      );
    }
    // 2b) Evidence is required, not optional (safeguard 1): a verified source interaction OR an
    //     attributable note. 'other' channel always requires a note (§6 cross-field rule).
    const note = args.note === undefined || args.note === null ? null : args.note.trim();
    const hasNote = note !== null && note.length > 0;
    const sourceId = args.sourceInteractionId ?? null;
    if (!hasNote && (sourceId === null || args.channel === 'other')) {
      throw new AramoError(
        'VALIDATION_ERROR',
        sourceId === null
          ? 'A note is required when no source interaction is identified'
          : 'A note is required when the response channel is "other"',
        422,
        {
          requestId: args.requestId,
          details: { field: 'note', reason: sourceId === null ? 'note_required_without_source' : 'note_required_for_other' },
        },
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

    // 4) v1.2 §7.2(a)/§7.4 safeguard 2 — the named source must be a real interaction in this
    //    tenant, bound to THIS Talent and THIS requisition, whose latest outcome is substantive.
    if (sourceId !== null) {
      const facts = await this.comms.findSourceInteractionFacts({
        tenant_id: args.auth.tenant_id,
        interaction_id: sourceId,
        talent_record_id: pipeline.talent_record_id,
        requisition_id: pipeline.requisition_id,
      });
      const reason =
        facts === null
          ? 'source_not_found'
          : !facts.talent_ok
            ? 'source_talent_mismatch'
            : !facts.requisition_ok
              ? 'source_requisition_mismatch'
              : facts.latest_disposition !== null && NON_SUBSTANTIVE_SOURCE_DISPOSITIONS.includes(facts.latest_disposition)
                ? 'source_not_substantive'
                : null;
      if (reason !== null) {
        throw new AramoError(
          'PIPELINE_EVIDENCE_INADMISSIBLE',
          reason === 'source_not_substantive'
            ? 'That interaction’s outcome is not a substantive Talent response'
            : 'That interaction cannot ground this Talent response',
          422,
          { requestId: args.requestId, details: { field: 'source_interaction_id', reason } },
        );
      }
    }

    // 5) v1.2 §7.5 / §5 (S2) — the requisition status. On closed / canceled the ONLY permitted
    //    operation is a HISTORICAL append: a response that occurred BEFORE the requisition closed
    //    is recorded but NEVER advances the Pipeline (so a backdated entry cannot get around the
    //    terminal rule). Any other status that does not permit RESPONSE is refused before any
    //    write, so no confirmation is left behind without its milestone.
    const reqStatus = await this.requisitions.findStatusById({
      tenant_id: args.auth.tenant_id,
      id: pipeline.requisition_id,
    });
    let historicalOnly = false;
    if (reqStatus !== null && isTerminalRequisitionStatus(reqStatus)) {
      const closedAt = await this.requisitions.findClosingInstant({
        tenant_id: args.auth.tenant_id,
        id: pipeline.requisition_id,
      });
      if (closedAt === null || args.occurredAt.getTime() >= closedAt.getTime()) {
        throw this.notAdvanceable(args.requestId, pipeline, reqStatus, closedAt);
      }
      historicalOnly = true;
    } else if (reqStatus === null || !requisitionPermits(reqStatus, 'RESPONSE')) {
      throw this.notAdvanceable(args.requestId, pipeline, reqStatus, null);
    }

    // 6) ATOMIC confirmation write (interaction + talent/req/pipeline associations +
    //    response_confirmed disposition + source id, one transaction). Idempotent on the
    //    recorder key: a retried submit returns the existing interaction (deduped) with no
    //    second write; a genuinely separate response carries a distinct key (watch-item #1/#3).
    const recorded = await this.comms.recordAttestedResponse({
      tenant_id: args.auth.tenant_id,
      talent_record_id: pipeline.talent_record_id,
      requisition_id: pipeline.requisition_id,
      pipeline_id: pipeline.id,
      channel: args.channel,
      occurred_at: args.occurredAt,
      recorded_by_id: args.auth.sub,
      disposition: 'response_confirmed',
      note: hasNote ? note : null,
      idempotency_key: args.idempotencyKey,
      source_interaction_id: sourceId,
    });
    const accountable = {
      interaction_id: recorded.interaction_id,
      deduped: recorded.deduped,
      occurred_at: args.occurredAt,
      recorded_at: recorded.recorded_at,
      recorded_by_id: recorded.dispositioned_by_id,
    };

    if (historicalOnly) {
      this.logger.log({
        event: 'talent_response_recorded_historical',
        tenant_id: args.auth.tenant_id,
        pipeline_id: pipeline.id,
        interaction_id: recorded.interaction_id,
        requisition_status: reqStatus,
      });
      return { ...accountable, pipeline, advanced: false };
    }

    // 7) Advance through the CANONICAL evidence-bearing path. reconcileForward walks FORWARD
    //    (no_contact→contacted→talent_responded) in ONE transaction, each hop grounded on THIS
    //    confirmation (kind recruiter_response_confirmation, verified in-transaction). IDEMPOTENT
    //    (already at/past target → no-op), CAS-protected, forward-only. A concurrent advance
    //    surfaces as 409 for the FE's "journey changed" path (§10); the confirmation is already
    //    durable, so a retry (same key) dedupes then re-reconciles.
    const advanced = await this.pipelines.reconcileForward({
      tenant_id: args.auth.tenant_id,
      id: pipeline.id,
      target: 'talent_responded',
      changed_by_id: args.auth.sub,
      requestId: args.requestId,
      visible_requisition_ids: args.visibleRequisitionIds,
      evidence: { kind: 'recruiter_response_confirmation', id: recorded.interaction_id },
    });

    this.logger.log({
      event: 'talent_response_recorded',
      tenant_id: args.auth.tenant_id,
      pipeline_id: pipeline.id,
      interaction_id: recorded.interaction_id,
      deduped: recorded.deduped,
      to_status: advanced.status,
    });
    return { ...accountable, pipeline: advanced, advanced: advanced.version !== pipeline.version };
  }

  private notAdvanceable(
    requestId: string,
    pipeline: PipelineView,
    status: string | null,
    closedAt: Date | null,
  ): AramoError {
    return new AramoError(
      'REQUISITION_NOT_ADVANCEABLE',
      closedAt !== null
        ? 'This requisition closed before that time; only a response that occurred before it closed can be recorded'
        : 'A Talent response cannot be recorded while the requisition is in its current status',
      409,
      {
        requestId,
        details: {
          pipeline_id: pipeline.id,
          status,
          activity: 'RESPONSE',
          ...(closedAt === null ? {} : { closed_at: closedAt.toISOString() }),
        },
      },
    );
  }
}
