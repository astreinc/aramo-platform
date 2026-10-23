import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';
import { TalentExtractionService } from '@aramo/talent-extraction';
import type { TalentIntakeDraftRow } from '@aramo/talent-evidence';

import { ResumeExtractionOrchestrator } from '../resume-extraction/resume-extraction.orchestrator.js';

import {
  classifyIntakeOutcome,
  mergeExtractionIntoReview,
} from './talent-intake-review.js';
import type { TalentIntakeProcessingPort } from './talent-intake-processing.port.js';

// ADR-0033 — the RUNTIME-NEUTRAL Talent Intake extraction service. This is the
// CAS-claimed idempotent processing path, extracted VERBATIM from the former
// BullMQ ResumeExtractionDraftProcessor so the transport cutover (BullMQ →
// EventBridge/SQS/Lambda) carries ZERO semantic drift. It knows nothing of
// BullMQ, SQS, Lambda, or EventBridge — it is the single implementation behind
// TALENT_INTAKE_PROCESSING_PORT, invoked by the runtime-neutral message handler.
// ATI-SEP-1 A4 — claim attempts per delivery before yielding to the next one.
const MAX_CLAIM_ATTEMPTS = 3;

@Injectable()
export class TalentIntakeExtractionService implements TalentIntakeProcessingPort {
  constructor(
    private readonly orchestrator: ResumeExtractionOrchestrator,
    private readonly talentExtraction: TalentExtractionService,
    @Inject('TalentIntakeExtractionServiceLogger')
    private readonly logger: AramoLogger,
  ) {}

  // Process ONE intake draft. CAS-claims it QUEUED → PROCESSING so at-least-once
  // delivery / duplicate ticks produce exactly one processor. Returns true only
  // if THIS call claimed and ran the extraction. Never throws out of the job.
  async processIntakeDraft(input: {
    draft_id: string;
    tenant_id: string;
    correlation_id?: string | null;
  }): Promise<boolean> {
    // ATI-SEP-1 A4 — bounded re-read + re-claim. The claim CASes on the version
    // just read; a recruiter review save landing between that read and the claim
    // bumps the version WITHOUT claiming, so a single attempt would leave the
    // draft QUEUED forever. A lost CAS therefore re-reads: still QUEUED (and not
    // promoted) at a newer version → claim again on that version; anything else
    // (a concurrent worker claimed it / terminal / promoted) → idempotent no-op.
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
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
      if (intake.processing_status !== 'QUEUED' || intake.promoted_talent_record_id !== null) {
        // Already claimed / processed / terminal / promoted — idempotent no-op.
        return false;
      }
      const claimed = await this.talentExtraction.claimTalentIntakeDraftForProcessing({
        tenant_id: intake.tenant_id,
        id: intake.id,
        expected_version: intake.version,
      });
      if (claimed > 0) {
        await this.runIntakeExtraction(intake, input.correlation_id ?? null);
        return true;
      }
    }
    // Still contended after the bound — leave it to the next delivery / drain.
    this.logger.warn({
      event: 'talent_intake_extract_skipped',
      reason: 'claim_contended',
      draft_id: input.draft_id,
    });
    return false;
  }

  private async runIntakeExtraction(
    intake: TalentIntakeDraftRow,
    correlationId: string | null,
  ): Promise<void> {
    // ADR-0033 Decision 5 — non-artifact source admission. A draft with no
    // uploaded object has no résumé to extract: the producer-supplied
    // structured_payload (if any) IS the review basis, so transition straight to
    // a terminal state with NO extraction child. READY when structured evidence
    // is present, else PARTIAL (manual entry still allowed). Loop-free (terminal)
    // and idempotent.
    if (intake.storage_key === null) {
      const hasStructured =
        intake.structured_payload !== null && intake.structured_payload !== undefined;
      await this.talentExtraction.markTalentIntakeDraftProcessed({
        tenant_id: intake.tenant_id,
        id: intake.id,
        processing_status: hasStructured ? 'READY' : 'PARTIAL',
        structured_payload: intake.structured_payload ?? undefined,
        review_payload: intake.structured_payload ?? undefined,
        warning_code: hasStructured ? null : 'NO_ARTIFACT_NO_STRUCTURED',
        failure_code: null,
        failure_detail: null,
        processing_completed_at: new Date(),
      });
      this.logger.log({
        event: 'talent_intake_non_artifact_processed',
        draft_id: intake.id,
        tenant_id: intake.tenant_id,
        processing_status: hasStructured ? 'READY' : 'PARTIAL',
        correlation_id: correlationId,
      });
      return;
    }

    // storage_key is non-null past the guard; capture it (TS narrowing on a
    // property is reset by the intervening repo calls below).
    const storageKey: string = intake.storage_key;

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
        { kind: 'CREATE_DRAFT_UPLOAD', storage_key: storageKey },
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

    const isFailed = outcome.processing_status === 'FAILED';
    // Review merge (I7 / §8.5) — against the LATEST persisted review, under CAS,
    // so a recruiter save made while the extraction ran is never overwritten. A
    // failed extraction leaves the review untouched (nothing disappears).
    if (!isFailed) {
      await this.mergeIntoLatestReview(intake, result);
    }
    await this.talentExtraction.markTalentIntakeDraftProcessed({
      tenant_id: intake.tenant_id,
      id: intake.id,
      processing_status: outcome.processing_status,
      structured_payload: result,
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

  // Merge the extraction result into the draft's CURRENT review payload with a
  // version CAS, re-reading and re-merging when a recruiter save lands in
  // between. Bounded: after the attempts the latest recruiter state stands and
  // the result stays on structured_payload (still promotable evidence).
  private async mergeIntoLatestReview(
    intake: TalentIntakeDraftRow,
    result: Parameters<typeof mergeExtractionIntoReview>[1],
  ): Promise<void> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const latest = await this.talentExtraction.findTalentIntakeDraftById({
        tenant_id: intake.tenant_id,
        id: intake.id,
      });
      if (latest === null || latest.promoted_talent_record_id !== null) {
        return;
      }
      const saved = await this.talentExtraction.saveTalentIntakeDraftReview({
        tenant_id: intake.tenant_id,
        id: intake.id,
        expected_version: latest.version,
        review_payload: mergeExtractionIntoReview(latest.review_payload, result),
      });
      if (saved === 1) {
        return;
      }
    }
    this.logger.warn({
      event: 'talent_intake_review_merge_contended',
      draft_id: intake.id,
      tenant_id: intake.tenant_id,
    });
  }
}
