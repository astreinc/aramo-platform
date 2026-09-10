import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';
import { CommunicationsRepository } from '@aramo/communications';
import {
  CI_ANALYSIS_SCHEMA_VERSION,
  CI_PROMPT_TEMPLATE_ID,
  CI_PROMPT_TEMPLATE_SHA256,
  CI_PROMPT_TEMPLATE_VERSION,
  CONVERSATION_INTELLIGENCE_MODEL_PROVIDER,
  ConversationIntelligenceRunRepository,
  NORMALIZED_TRANSCRIPT_SOURCE,
  type ConversationIntelligenceModelProvider,
  type NormalizedTranscriptSource,
} from '@aramo/conversation-intelligence';

import { CiProcessingConfig } from './ci-processing.config.js';
import { CiProcessingProducer } from './ci-processing.producer.js';
import { CiSnapshotResolver } from './ci-snapshot-resolver.js';

// CI-B6P §14/§15/§16/§17/§19 — the provider-NEUTRAL normalized-ready scheduling
// seam. Input is IDENTIFIERS ONLY (no Zoom/provider event object). It does NO
// model call (safe to run on a request/webhook thread). Steps:
//   1. activation gate — disabled → no-op (fully dark);
//   2. model config fail-closed;
//   3. load the normalized transcript (evidence anchor);
//   4. resolve Talent by DURABLE association (0→park, >1→intervention);
//   5. resolve Requisition by DURABLE association (0→park, >1→intervention) —
//      NO heuristic (latest pipeline / recency / phone / UI);
//   6. capture/reuse the immutable B2 snapshot;
//   7. create/reuse the durable queued run (run-before-enqueue);
//   8. enqueue identifiers only.
// The worker performs the immediate ai_processing re-check before any model call.

export type CiScheduleReason =
  | 'queued'
  | 'disabled'
  | 'config_invalid'
  | 'transcript_not_ready'
  | 'no_talent'
  | 'ambiguous_talent'
  | 'no_requisition'
  | 'ambiguous_requisition';

export interface CiScheduleCommand {
  readonly tenant_id: string;
  readonly conversation_transcript_id: string;
  readonly request_id?: string;
}

export interface CiScheduleResult {
  readonly scheduled: boolean;
  readonly reason: CiScheduleReason;
  readonly run_id?: string;
}

@Injectable()
export class NormalizedTranscriptReadyHandler {
  constructor(
    private readonly config: CiProcessingConfig,
    @Inject(NORMALIZED_TRANSCRIPT_SOURCE)
    private readonly transcripts: NormalizedTranscriptSource,
    private readonly comms: CommunicationsRepository,
    private readonly snapshotResolver: CiSnapshotResolver,
    private readonly runs: ConversationIntelligenceRunRepository,
    @Inject(CONVERSATION_INTELLIGENCE_MODEL_PROVIDER)
    private readonly model: ConversationIntelligenceModelProvider,
    private readonly producer: CiProcessingProducer,
    @Inject('NormalizedTranscriptReadyHandlerLogger')
    private readonly logger: AramoLogger,
  ) {}

  async schedule(command: CiScheduleCommand): Promise<CiScheduleResult> {
    const { tenant_id, conversation_transcript_id } = command;

    // 1. Activation gate — dark by default. Nothing is created when disabled.
    if (!this.config.isEnabled()) return { scheduled: false, reason: 'disabled' };
    // 2. Model config fail-closed.
    if (!this.config.isReady()) {
      this.logger.warn({ event: 'ci_schedule_config_invalid', tenant_id });
      return { scheduled: false, reason: 'config_invalid' };
    }

    // 3. Load the normalized transcript (evidence anchor).
    const load = await this.transcripts.load(tenant_id, conversation_transcript_id);
    if (load.status === 'not_found' || load.status === 'not_ready') {
      return { scheduled: false, reason: 'transcript_not_ready' };
    }
    const meta =
      load.status === 'ready'
        ? { interaction_id: load.view.interaction_id, normalized_sha256: load.view.normalized_sha256 }
        : load.meta;

    // 4. Talent by DURABLE association (never inference).
    const talentIds = await this.comms.findTalentSubjectIdsForInteraction(tenant_id, meta.interaction_id);
    if (talentIds.length === 0) return { scheduled: false, reason: 'no_talent' };
    if (talentIds.length > 1) return { scheduled: false, reason: 'ambiguous_talent' };

    // 5. Requisition by DURABLE association (never inference).
    const requisitionIds = await this.comms.findRequisitionIdsForInteraction(tenant_id, meta.interaction_id);
    if (requisitionIds.length === 0) return { scheduled: false, reason: 'no_requisition' };
    if (requisitionIds.length > 1) return { scheduled: false, reason: 'ambiguous_requisition' };
    const requisitionId = requisitionIds[0] as string;

    // 6. Capture/reuse the immutable B2 snapshot.
    const snapshotId = await this.snapshotResolver.resolveSnapshotId(
      tenant_id,
      requisitionId,
      command.request_id !== undefined ? { request_id: command.request_id } : undefined,
    );

    // 7. Durable run BEFORE enqueue (analysis-identity key; find-or-create).
    const identity = this.model.modelIdentity();
    const run = await this.runs.createOrGetQueued({
      tenant_id,
      conversation_transcript_id,
      requisition_analysis_context_snapshot_id: snapshotId,
      interaction_id: meta.interaction_id,
      normalized_sha256: meta.normalized_sha256,
      model_provider: identity.provider,
      model_name: identity.model,
      model_version: identity.version ?? null,
      prompt_template_id: CI_PROMPT_TEMPLATE_ID,
      prompt_template_version: CI_PROMPT_TEMPLATE_VERSION,
      prompt_sha256: CI_PROMPT_TEMPLATE_SHA256,
      output_schema_version: CI_ANALYSIS_SCHEMA_VERSION,
    });

    // 8. Enqueue identifiers only (Redis-gated; run stays recoverable if absent).
    await this.producer.enqueueRun(run.id, tenant_id);
    return { scheduled: true, reason: 'queued', run_id: run.id };
  }
}
