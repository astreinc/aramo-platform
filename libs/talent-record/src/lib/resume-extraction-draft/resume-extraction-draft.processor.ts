import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AramoError, type AramoLogger, RedisConnectionConfig } from '@aramo/common';
import { TalentExtractionService } from '@aramo/talent-extraction';

import { ResumeExtractionOrchestrator } from '../resume-extraction/resume-extraction.orchestrator.js';

import {
  RESUME_EXTRACTION_DRAFT_BATCH_SIZE,
  RESUME_EXTRACTION_DRAFT_QUEUE_NAME,
} from './resume-extraction-draft.queue.constants.js';

// TALENT-INTEL-1 (TI-1F-A) — the résumé-extraction-draft tick worker. Drains
// PROCESSING ResumeExtractionDraft rows (the polling-outbox signal written at
// the existing-Talent add-résumé-edition seam) via ONE governed
// ResumeExtractionOrchestrator ATTACHMENT extraction per draft, then
// READY_FOR_REVIEW (or FAILED). It writes NO typed Talent evidence — the draft
// is pre-confirmation review state (TI-1F-B owns confirm/promotion).
//
// Lifecycle mirrors ResumeReindexProcessor / CanonicalizationTriggerProcessor
// (ADR-0018 Decision 1): manualRegistration + onApplicationBootstrap gate on
// RedisConnectionConfig.isConfigured. Boot is silent when Redis is unconfigured
// (CI, local dev); the worker registers only when REDIS_URL is present. The
// proofs exercise drainProcessingBatch directly — no live worker needed.
//
// EXISTING-Talent extraction is worker-owned AFTER enqueue: once the add-edition
// seam writes a PROCESSING draft, the PROCESSING → READY_FOR_REVIEW | FAILED
// transition happens ONLY here. (The CREATE_DRAFT_UPLOAD flow is synchronous in
// A and never enters this worker — the intentional transitional asymmetry.)

// Governed technical-failure statuses (§13/R9): the extraction ran but produced
// no reviewable result → the draft is FAILED, not READY_FOR_REVIEW.
const EXTRACTION_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'provider_truncated',
  'invalid_structured_output',
  'provider_failure',
]);

export interface ResumeExtractionDraftTickInput {
  override_batch_size?: number;
}

export interface DraftDrainResult {
  attempted: number;
  ready_for_review: number;
  failed: number;
}

@Processor(RESUME_EXTRACTION_DRAFT_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class ResumeExtractionDraftProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly orchestrator: ResumeExtractionOrchestrator,
    private readonly talentExtraction: TalentExtractionService,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('ResumeExtractionDraftProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job<ResumeExtractionDraftTickInput>): Promise<void> {
    const limit = job.data.override_batch_size ?? RESUME_EXTRACTION_DRAFT_BATCH_SIZE;
    const result = await this.drainProcessingBatch({ limit });
    this.logger.log({
      event: 'resume_extraction_draft_tick_completed',
      job_id: job.id ?? null,
      attempted: result.attempted,
      ready_for_review: result.ready_for_review,
      failed: result.failed,
    });
  }

  // Exposed for the integration proof — exercises the drain seam end-to-end
  // without a live BullMQ worker (the résumé-reindex precedent). Per-draft
  // isolation: one bad draft is marked FAILED and never aborts the batch.
  async drainProcessingBatch(args: { limit: number }): Promise<DraftDrainResult> {
    const drafts = await this.talentExtraction.findProcessingResumeExtractionDrafts({
      limit: args.limit,
    });
    let ready_for_review = 0;
    let failed = 0;

    for (const draft of drafts) {
      // A only worker-processes ATTACHMENT drafts. A PROCESSING draft that is not
      // an existing-Talent ATTACHMENT (missing talent_id / wrong kind) cannot be
      // extracted here — mark it FAILED (defensive; should not occur in A, where
      // CREATE_DRAFT_UPLOAD drafts are persisted READY_FOR_REVIEW synchronously).
      if (draft.source_kind !== 'ATTACHMENT' || draft.talent_id === null) {
        await this.talentExtraction.markResumeExtractionDraftFailed({
          id: draft.id,
          last_error_code: 'INVALID_DRAFT_SOURCE',
          last_error_at: new Date(),
        });
        failed += 1;
        continue;
      }

      try {
        // ONE governed extraction (ATTACHMENT source; the authorizer resolves the
        // owned attachment → storage_key inside the orchestrator).
        const result = await this.orchestrator.extractResume(
          {
            kind: 'ATTACHMENT',
            attachment_id: draft.source_ref,
            talent_id: draft.talent_id,
          },
          {
            tenant_id: draft.tenant_id,
            requestId: `resume-extraction-draft:${draft.id}`,
          },
        );

        if (
          result.extraction_status !== undefined &&
          EXTRACTION_FAILURE_STATUSES.has(result.extraction_status)
        ) {
          await this.talentExtraction.markResumeExtractionDraftFailed({
            id: draft.id,
            last_error_code: result.extraction_status,
            last_error_at: new Date(),
          });
          failed += 1;
          continue;
        }

        // The grounded governed output is the reviewable draft payload — NOT
        // Talent evidence. Confirm/promotion is TI-1F-B.
        await this.talentExtraction.markResumeExtractionDraftReadyForReview({
          id: draft.id,
          structured_payload: result,
          source_map_version: result.source_map_version ?? null,
          resume_text_hash: result.resume_text_hash ?? null,
        });
        ready_for_review += 1;
      } catch (err: unknown) {
        // The orchestrator does not normally throw (failure branches return an
        // object), but an unexpected throw degrades the draft to FAILED, never
        // aborts the batch.
        await this.talentExtraction.markResumeExtractionDraftFailed({
          id: draft.id,
          last_error_code: err instanceof AramoError ? err.code : 'EXTRACTION_FAILED',
          last_error_at: new Date(),
        });
        failed += 1;
      }
    }

    return { attempted: drafts.length, ready_for_review, failed };
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'resume_extraction_draft_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
