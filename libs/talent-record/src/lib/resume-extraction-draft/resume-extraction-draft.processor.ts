import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AramoError, type AramoLogger, RedisConnectionConfig } from '@aramo/common';
import { TalentExtractionService } from '@aramo/talent-extraction';
import type { TalentIntakeDraftRow } from '@aramo/talent-evidence';

import { ResumeExtractionOrchestrator } from '../resume-extraction/resume-extraction.orchestrator.js';
import {
  TALENT_INTAKE_EXTRACT_JOB_NAME,
  TALENT_INTAKE_QUEUED_DRAIN_BATCH_SIZE,
} from '../talent-intake/talent-intake.constants.js';
import {
  classifyIntakeOutcome,
  mergeExtractionIntoReview,
} from '../talent-intake/talent-intake-review.js';

import {
  RESUME_EXTRACTION_DRAFT_BATCH_SIZE,
  RESUME_EXTRACTION_DRAFT_QUEUE_NAME,
} from './resume-extraction-draft.queue.constants.js';

// TALENT-INTEL-1 (TI-1F-A) — the resume-extraction-draft tick worker. Drains
// PROCESSING ResumeExtractionDraft rows (the polling-outbox signal written at
// the existing-Talent add-resume-edition seam) via ONE governed
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

// Durable Async Talent Intake — the per-draft extraction job enqueued by the
// relay (named job on this same queue), plus the safety-net drain result.
export interface TalentIntakeExtractJobInput {
  draft_id: string;
  tenant_id: string;
  correlation_id?: string | null;
}

export interface IntakeDrainResult {
  attempted: number;
  completed: number;
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

  async process(
    job: Job<ResumeExtractionDraftTickInput | TalentIntakeExtractJobInput>,
  ): Promise<void> {
    // Per-draft intake extraction (enqueued by the relay, outbox-event-derived
    // job id → at-least-once safe via the CAS claim).
    if (job.name === TALENT_INTAKE_EXTRACT_JOB_NAME) {
      const data = job.data as TalentIntakeExtractJobInput;
      await this.processIntakeDraft({
        draft_id: data.draft_id,
        tenant_id: data.tenant_id,
        correlation_id: data.correlation_id ?? null,
      });
      return;
    }

    // The scheduled tick drives BOTH legacy paths: the existing-Talent ATTACHMENT
    // drain (the dead-worker repair) AND a safety-net drain of QUEUED intake
    // drafts the relay may not have enqueued (Redis down at commit / relay lag).
    const limit =
      (job.data as ResumeExtractionDraftTickInput).override_batch_size ??
      RESUME_EXTRACTION_DRAFT_BATCH_SIZE;
    const attachment = await this.drainProcessingBatch({ limit });
    const intake = await this.drainQueuedIntakeBatch({
      limit: TALENT_INTAKE_QUEUED_DRAIN_BATCH_SIZE,
    });
    this.logger.log({
      event: 'resume_extraction_draft_tick_completed',
      job_id: job.id ?? null,
      attempted: attachment.attempted,
      ready_for_review: attachment.ready_for_review,
      failed: attachment.failed,
      intake_attempted: intake.attempted,
      intake_completed: intake.completed,
    });
  }

  // Exposed for the integration proof — exercises the drain seam end-to-end
  // without a live BullMQ worker (the resume-reindex precedent). Per-draft
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

  // Durable Async Talent Intake — process ONE intake draft. CAS-claims it
  // QUEUED → PROCESSING so at-least-once queue delivery / duplicate ticks
  // produce exactly one processor. Returns true only if THIS call claimed and
  // ran the extraction. Never throws out of the job.
  async processIntakeDraft(input: {
    draft_id: string;
    tenant_id: string;
    correlation_id?: string | null;
  }): Promise<boolean> {
    const intake = await this.talentExtraction.findTalentIntakeDraftById({
      tenant_id: input.tenant_id,
      id: input.draft_id,
    });
    if (intake === null) {
      this.logger.warn({
        event: 'talent_intake_extract_skipped',
        reason: 'draft_missing',
        draft_id: input.draft_id,
      });
      return false;
    }
    if (intake.processing_status !== 'QUEUED') {
      // Already claimed / processed / terminal — idempotent no-op.
      return false;
    }
    const claimed = await this.talentExtraction.claimTalentIntakeDraftForProcessing({
      tenant_id: intake.tenant_id,
      id: intake.id,
      expected_version: intake.version,
    });
    if (claimed === 0) {
      // Lost the CAS race to a concurrent worker — never double-process.
      return false;
    }
    await this.runIntakeExtraction(intake, input.correlation_id ?? null);
    return true;
  }

  private async runIntakeExtraction(
    intake: TalentIntakeDraftRow,
    correlationId: string | null,
  ): Promise<void> {
    // The governed-extraction CHILD — stable id per intake (idempotent upsert),
    // PROCESSING until the result lands. The child is the evidence authority
    // reused by promotion; the parent intake carries workflow state only.
    const child = await this.talentExtraction.upsertResumeExtractionDraft({
      tenant_id: intake.tenant_id,
      source_kind: 'CREATE_DRAFT_UPLOAD',
      source_ref: intake.id,
      status: 'PROCESSING',
      created_at: new Date(),
      created_by: intake.created_by,
    });

    let result;
    try {
      // ONE governed extraction against the already-uploaded object. The SAME
      // shared orchestrator the ATTACHMENT path uses (no re-implementation).
      result = await this.orchestrator.extractResume(
        { kind: 'CREATE_DRAFT_UPLOAD', storage_key: intake.storage_key },
        { tenant_id: intake.tenant_id, requestId: `talent-intake:${intake.id}` },
      );
    } catch (err: unknown) {
      const code = err instanceof AramoError ? err.code : 'EXTRACTION_FAILED';
      await this.talentExtraction.markResumeExtractionDraftFailed({
        id: child.id,
        last_error_code: code,
        last_error_at: new Date(),
      });
      await this.talentExtraction.markTalentIntakeDraftProcessed({
        tenant_id: intake.tenant_id,
        id: intake.id,
        processing_status: 'FAILED',
        resume_extraction_draft_id: child.id,
        failure_code: 'EXTRACTION_FAILED',
        failure_detail:
          'We couldn’t prepare the résumé details. Your uploaded résumé is safe.',
        processing_completed_at: new Date(),
      });
      return;
    }

    const outcome = classifyIntakeOutcome(result);

    // CHILD first (evidence authority), THEN the parent workflow state.
    if (outcome.processing_status === 'FAILED') {
      await this.talentExtraction.markResumeExtractionDraftFailed({
        id: child.id,
        last_error_code: outcome.failure_code ?? 'EXTRACTION_FAILED',
        last_error_at: new Date(),
      });
    } else {
      await this.talentExtraction.markResumeExtractionDraftReadyForReview({
        id: child.id,
        structured_payload: result,
        source_map_version: result.source_map_version ?? null,
        resume_text_hash: result.resume_text_hash ?? null,
      });
    }

    const mergedReview = mergeExtractionIntoReview(intake.review_payload, result);
    const isFailed = outcome.processing_status === 'FAILED';
    await this.talentExtraction.markTalentIntakeDraftProcessed({
      tenant_id: intake.tenant_id,
      id: intake.id,
      processing_status: outcome.processing_status,
      structured_payload: result,
      review_payload: mergedReview,
      // warning_code / failure_detail carry RECRUITER-SAFE prose (from the shared
      // orchestrator). The internal error code lives ONLY on the child
      // (last_error_code) and is never projected onto the recruiter contract.
      warning_code: isFailed ? null : result.warning ?? null,
      failure_code: isFailed ? outcome.failure_code ?? 'EXTRACTION_FAILED' : null,
      failure_detail: isFailed
        ? result.warning ??
          'We couldn’t prepare the résumé details. Your uploaded résumé is safe.'
        : null,
      extraction_contract_version: result.source_map_version ?? null,
      resume_extraction_draft_id: child.id,
      processing_completed_at: new Date(),
    });

    // Completion log — closes the correlation chain (draft ↔ child ↔ outcome).
    this.logger.log({
      event: 'talent_intake_extraction_completed',
      draft_id: intake.id,
      tenant_id: intake.tenant_id,
      resume_extraction_draft_id: child.id,
      processing_status: outcome.processing_status,
      correlation_id: correlationId,
    });
  }

  // Safety-net drain — QUEUED intake drafts the relay has not enqueued (Redis
  // down at commit, relay lag). Each runs the same CAS-guarded path, so it
  // coexists with the relay without double-work.
  async drainQueuedIntakeBatch(args: { limit: number }): Promise<IntakeDrainResult> {
    const drafts = await this.talentExtraction.findQueuedTalentIntakeDrafts({
      limit: args.limit,
    });
    let completed = 0;
    for (const draft of drafts) {
      try {
        const processed = await this.processIntakeDraft({
          draft_id: draft.id,
          tenant_id: draft.tenant_id,
        });
        if (processed) {
          completed += 1;
        }
      } catch (err: unknown) {
        this.logger.warn({
          event: 'talent_intake_drain_error',
          draft_id: draft.id,
          reason: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
    return { attempted: drafts.length, completed };
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
