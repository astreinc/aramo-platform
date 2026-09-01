import { Inject, Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  ClientSelectionProcessRepository,
  considerationEffect,
  isDispositionOutcomeState,
  type ClientSelectionProcessView,
  type DispositionOutcomeState,
} from '@aramo/client-selection';
import { PipelineRepository, isLiveStatus } from '@aramo/pipeline';

// L3-E(2) — governed client-decision (DECLINE/WITHDRAW) → Pipeline disposition.
//
// This is the ONE seam that bridges a Client-Selection terminal decision to the upstream
// qualified Pipeline episode. It lives OUTSIDE apps/api/src/client-selection precisely so
// the pure create/transition surfaces stay pipeline-free (L3-A guard W2); the disposition
// write goes only through the system-gated PipelineRepository.dispositionDownstream —
// Client Selection never mutates Pipeline directly.
//
// Behaviour (ruling):
//   1. Owner-lib transition to DECLINED/WITHDRAWN (CAS + immutable actor/reason event).
//   2. Classify the outcome with the closed considerationEffect():
//        TERMINATES_CONSIDERATION → disposition the linked Pipeline episode to
//          not_in_consideration (idempotent: an already-terminal episode is never reopened).
//        PRESERVES_QUALIFICATION  → leave the Pipeline qualified (only this attempt ended).
//   A WITHDRAWN with no valid closed reason is refused 422 (never guessed).

// Fixed, audit-stable system actor for the system-only disposition (not a person).
export const CLIENT_DECISION_SYSTEM_ACTOR_ID = '01900000-0000-7000-8000-00000000cdec';
const SYSTEM_DISPOSITION_SCOPES: readonly string[] = ['pipeline:complete'];

interface RawReadDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}
interface SubmittalPipelineRow {
  readonly pipeline_id: string | null;
}

@Injectable()
export class ClientDecisionOrchestrator {
  private readonly logger = new Logger(ClientDecisionOrchestrator.name);

  constructor(
    private readonly clientSelection: ClientSelectionProcessRepository,
    private readonly pipeline: PipelineRepository,
    @Inject('ClientDecisionDb') private readonly db: RawReadDb,
  ) {}

  async decide(args: {
    tenant_id: string;
    id: string;
    to_state: string;
    expected_version: number;
    reason_code?: string;
    note?: string;
    changed_by_id: string;
    visible_requisition_ids: ReadonlySet<string> | null;
    requestId: string;
  }): Promise<{ process: ClientSelectionProcessView; pipeline_dispositioned: boolean }> {
    if (!isDispositionOutcomeState(args.to_state)) {
      throw new AramoError(
        'INVALID_CLIENT_SELECTION_TRANSITION',
        `The decision endpoint handles only DECLINED/WITHDRAWN; got ${args.to_state}`,
        422,
        { requestId: args.requestId, details: { to_state: args.to_state } },
      );
    }
    const toState: DispositionOutcomeState = args.to_state;

    // Closed classification — deterministic, never inferred from free text.
    const effect = considerationEffect({ to_state: toState, reason_code: args.reason_code });
    if (effect === null) {
      throw new AramoError(
        'CLIENT_SELECTION_WITHDRAW_REASON_INVALID',
        'A WITHDRAWN decision requires a valid closed reason_code (TERMINATES vs PRESERVES)',
        422,
        { requestId: args.requestId, details: { to_state: toState, reason_code: args.reason_code ?? null } },
      );
    }

    // 1. Owner-lib transition (CAS + immutable provenance: actor + reason_code).
    const process = await this.clientSelection.transition({
      tenant_id: args.tenant_id,
      id: args.id,
      to_state: toState,
      expected_version: args.expected_version,
      changed_by_id: args.changed_by_id,
      requestId: args.requestId,
      visible_requisition_ids: args.visible_requisition_ids,
      ...(args.note === undefined ? {} : { note: args.note }),
      ...(args.reason_code === undefined ? {} : { reason_code: args.reason_code }),
    });

    // 2. PRESERVES → the Talent stays valid for the requisition; Pipeline unchanged.
    if (effect === 'PRESERVES_QUALIFICATION') {
      this.logger.log({
        event: 'client_decision_preserves_qualification',
        request_id: args.requestId,
        tenant_id: args.tenant_id,
        client_selection_process_id: args.id,
        to_state: toState,
        reason_code: args.reason_code ?? null,
      });
      return { process, pipeline_dispositioned: false };
    }

    // 3. TERMINATES → resolve the exact Pipeline via the Submittal, then disposition it to
    //    not_in_consideration through the system-gated writer. Idempotent.
    const rows = await this.db.$queryRawUnsafe<SubmittalPipelineRow[]>(
      `SELECT "pipeline_id"
         FROM "submittal"."TalentSubmittalRecord"
        WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid
        LIMIT 1`,
      process.submittal_id,
      args.tenant_id,
    );
    const pipelineId = rows[0]?.pipeline_id ?? null;
    if (pipelineId === null) {
      this.logger.log({
        event: 'client_decision_no_linked_pipeline',
        request_id: args.requestId,
        tenant_id: args.tenant_id,
        client_selection_process_id: args.id,
      });
      return { process, pipeline_dispositioned: false };
    }

    const episode = await this.pipeline.findById({ tenant_id: args.tenant_id, id: pipelineId });
    if (episode === null || !isLiveStatus(episode.status as never)) {
      // Absent or already terminal — never reopen a closed episode.
      return { process, pipeline_dispositioned: false };
    }

    await this.pipeline.dispositionDownstream({
      tenant_id: args.tenant_id,
      id: pipelineId,
      expected_version: episode.version,
      changed_by_id: CLIENT_DECISION_SYSTEM_ACTOR_ID,
      requestId: args.requestId,
      visible_requisition_ids: null,
      scopes: SYSTEM_DISPOSITION_SCOPES,
      source_provenance: args.id,
      reason:
        toState === 'DECLINED' ? 'client_selection_declined' : 'client_selection_withdrawn',
      ...(args.reason_code === undefined ? {} : { note: args.reason_code }),
    });

    this.logger.log({
      event: 'client_decision_pipeline_dispositioned',
      request_id: args.requestId,
      tenant_id: args.tenant_id,
      client_selection_process_id: args.id,
      pipeline_id: pipelineId,
      to_state: toState,
    });
    return { process, pipeline_dispositioned: true };
  }
}
