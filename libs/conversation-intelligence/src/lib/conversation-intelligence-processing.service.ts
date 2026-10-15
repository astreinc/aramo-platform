// CI-B6 — the Conversation Intelligence processing orchestrator. Turns a
// normalized transcript + immutable Requisition snapshot + ai_processing consent
// into an IMMUTABLE run of AI-generated claims + transcript-span citations + a
// review-ready draft. It STOPS at `completed` (READY_FOR_REVIEW) — no approval,
// no workflow mutation, no numeric ordering, no protected-trait output. Every stage
// is idempotent; the run's analysis-identity key makes replay converge and a
// changed model/prompt/schema a NEW run.

import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  REQUISITION_SNAPSHOT_SOURCE,
  type RequisitionSnapshotSource,
} from './ports/requisition-snapshot-source.port.js';
import {
  ConversationIntelligenceRunRepository,
  type CiRunProvenance,
  type CiRunRow,
  type PersistClaimInput,
} from './conversation-intelligence-run.repository.js';
import { CI_PROCESSING_ERROR_CODES, CiAnalysisValidationError } from './domain/errors.js';
import type { ConversationIntelligenceRunStatus } from './domain/run-enums.js';
import { assertCiRunTransition } from './domain/run-state-machine.js';
import { validateAnalysisResult } from './analysis/analysis-validator.js';
import { validateCitationsAgainstTranscript } from './analysis/citation-validator.js';
import {
  CI_ANALYSIS_SCHEMA_VERSION,
  type AnalysisResultV1,
} from './analysis/analysis-schema.js';
import {
  CI_PROMPT_TEMPLATE_ID,
  CI_PROMPT_TEMPLATE_SHA256,
  CI_PROMPT_TEMPLATE_VERSION,
} from './analysis/prompt-template.js';
import {
  AI_PROCESSING_AUTHORIZATION,
  type AiProcessingAuthorizationPort,
} from './ports/ai-processing-authorization.port.js';
import {
  NORMALIZED_TRANSCRIPT_SOURCE,
  type NormalizedTranscriptSource,
  type NormalizedTranscriptView,
} from './ports/normalized-transcript-source.port.js';
import {
  CONVERSATION_INTELLIGENCE_MODEL_PROVIDER,
  type ConversationIntelligenceModelProvider,
} from './model/conversation-intelligence-model-provider.port.js';
import {
  CI_SCREENING_CLAIM_TYPE,
  CI_SCREENING_PROMPT_SHA256,
  CI_SCREENING_PROMPT_TEMPLATE_ID,
  CI_SCREENING_PROMPT_TEMPLATE_VERSION,
  CI_SCREENING_SCHEMA_VERSION,
  resolveScreeningCitations,
  validateScreeningAnalysisResult,
  type ScreeningAnalysisResultV1,
} from './analysis/screening-analysis.js';
import {
  SCREENING_ANALYSIS_CONTEXT_SOURCE,
  SCREENING_ANALYSIS_MODEL,
  SCREENING_FINDING_DRAFT_SINK,
  type ScreeningAnalysisContextSource,
  type ScreeningAnalysisModel,
  type ScreeningFindingDraftSink,
} from './ports/screening-analysis.port.js';

export const CI_MAX_PROCESSING_ATTEMPTS = 5;

export interface ProcessConversationIntelligenceCommand {
  readonly tenant_id: string;
  readonly conversation_transcript_id: string;
  readonly requisition_analysis_context_snapshot_id: string;
}

// INC-3 A1-5 — the SCREENING analysis profile command (Part D.1/D.2).
export interface ProcessScreeningAnalysisCommand {
  readonly tenant_id: string;
  readonly run_id: string;
}

export type CiProcessingOutcome =
  | 'completed'
  | 'blocked_not_authorized'
  | 'failed_retryable'
  | 'intervention_required'
  | 'failed_terminal'
  | 'transcript_not_ready'
  | 'transcript_not_found';

export interface CiProcessingResult {
  readonly outcome: CiProcessingOutcome;
  readonly run?: CiRunRow;
  readonly error_code?: string;
}

@Injectable()
export class ConversationIntelligenceProcessingService {
  constructor(
    private readonly repo: ConversationIntelligenceRunRepository,
    @Inject(REQUISITION_SNAPSHOT_SOURCE) private readonly snapshots: RequisitionSnapshotSource,
    @Inject(NORMALIZED_TRANSCRIPT_SOURCE) private readonly transcripts: NormalizedTranscriptSource,
    @Inject(AI_PROCESSING_AUTHORIZATION) private readonly authz: AiProcessingAuthorizationPort,
    @Inject(CONVERSATION_INTELLIGENCE_MODEL_PROVIDER) private readonly model: ConversationIntelligenceModelProvider,
    // INC-3 A1-5 — the screening-profile seams (bound at the composition root;
    // absent → a screening run fails closed, never falls back to another path).
    @Optional() @Inject(SCREENING_ANALYSIS_CONTEXT_SOURCE) private readonly screeningContext?: ScreeningAnalysisContextSource,
    @Optional() @Inject(SCREENING_FINDING_DRAFT_SINK) private readonly screeningSink?: ScreeningFindingDraftSink,
    @Optional() @Inject(SCREENING_ANALYSIS_MODEL) private readonly screeningModel?: ScreeningAnalysisModel,
  ) {}

  /**
   * INC-3 A1-5 — process one queued SCREENING-profile run. Same run state
   * machine, same independent fail-closed ai_processing gate before any model
   * call, same grounding-integrity and citation rules as process(). The
   * snapshot is optional; exactly-one session (and through it exactly-one
   * Talent) is required instead of exactly-one Requisition. Output lands as
   * DRAFT findings in the screening domain (reviewed there, D.3) and as the
   * run's immutable claims + coordinate-only citations here.
   */
  async processScreening(command: ProcessScreeningAnalysisCommand): Promise<CiProcessingResult> {
    const { tenant_id } = command;
    const run = await this.repo.findRunByIdInTenant(tenant_id, command.run_id);
    if (run === null || run.analysis_profile !== 'SCREENING' || run.screening_session_id === null) {
      return { outcome: 'transcript_not_found' };
    }
    if (run.status === 'completed') return { outcome: 'completed', run };
    if (this.screeningContext === undefined || this.screeningSink === undefined || this.screeningModel === undefined) {
      const processing = await this.transitionTo(tenant_id, run, 'processing', { started_at: new Date() });
      return this.toState(tenant_id, processing, 'failed_terminal', CI_PROCESSING_ERROR_CODES.SCREENING_PROFILE_UNAVAILABLE);
    }

    const load = await this.transcripts.load(tenant_id, run.conversation_transcript_id);
    if (load.status === 'not_found') return { outcome: 'transcript_not_found' };
    if (load.status === 'not_ready') return { outcome: 'transcript_not_ready' };

    const processing = await this.transitionTo(tenant_id, run, 'processing', { started_at: new Date() });

    // Exactly-one session → exactly-one Talent; the session must still be a
    // DRAFT and be linked to THIS transcript's meeting interaction.
    const ctx = await this.screeningContext.load(tenant_id, run.screening_session_id);
    if (ctx.status !== 'ready') {
      return this.toState(tenant_id, processing, 'failed_terminal', ctx.status === 'not_draft'
        ? CI_PROCESSING_ERROR_CODES.SCREENING_SESSION_NOT_DRAFT
        : CI_PROCESSING_ERROR_CODES.SCREENING_SESSION_NOT_FOUND);
    }
    if (ctx.context.interaction_id !== run.interaction_id) {
      return this.toState(tenant_id, processing, 'intervention_required', CI_PROCESSING_ERROR_CODES.SCREENING_SESSION_MISMATCH);
    }

    // ai_processing — independent, fail closed, BEFORE any model call (D.2).
    const decision = await this.authz.evaluate({ tenant_id, interaction_id: run.interaction_id });
    if (!decision.allowed) {
      if (decision.reason === 'no_talent') {
        return this.park(tenant_id, processing, CI_PROCESSING_ERROR_CODES.TALENT_ASSOCIATION_MISSING);
      }
      if (decision.reason === 'ambiguous_talent') {
        return this.toState(tenant_id, processing, 'intervention_required', CI_PROCESSING_ERROR_CODES.TALENT_ASSOCIATION_AMBIGUOUS);
      }
      return this.toState(tenant_id, processing, 'blocked_not_authorized', CI_PROCESSING_ERROR_CODES.AI_PROCESSING_NOT_AUTHORIZED);
    }

    if (load.status === 'artifact_not_found') {
      return this.toState(tenant_id, processing, 'failed_terminal', CI_PROCESSING_ERROR_CODES.NORMALIZED_ARTIFACT_NOT_FOUND);
    }
    if (load.status === 'hash_mismatch') {
      return this.toState(tenant_id, processing, 'failed_terminal', CI_PROCESSING_ERROR_CODES.NORMALIZED_HASH_MISMATCH);
    }
    const view: NormalizedTranscriptView = load.view;

    // Optional immutable Requisition snapshot (captured only when the session
    // carries a Requisition). A recorded-but-missing snapshot fails closed.
    let requisitionContext: unknown | null = null;
    if (run.requisition_analysis_context_snapshot_id !== null) {
      const snapshot = await this.snapshots.getSnapshot(tenant_id, run.requisition_analysis_context_snapshot_id);
      if (snapshot === null) {
        return this.toState(tenant_id, processing, 'failed_terminal', CI_PROCESSING_ERROR_CODES.REQUISITION_SNAPSHOT_NOT_FOUND);
      }
      requisitionContext = snapshot.context;
    }

    const sent = this.screeningModel.redactUtterances(view);
    const outcome = await this.screeningModel.generate({
      tenant_id,
      conversation_transcript_id: run.conversation_transcript_id,
      utterances: sent,
      context: ctx.context,
      requisition_context: requisitionContext,
    });
    if (outcome.kind === 'retryable_failure') return this.retryOrPark(tenant_id, processing, outcome.error_code);
    if (outcome.kind === 'terminal_failure') return this.toState(tenant_id, processing, 'failed_terminal', outcome.error_code);

    let result: ScreeningAnalysisResultV1;
    let spans: ReturnType<typeof resolveScreeningCitations>;
    try {
      result = validateScreeningAnalysisResult(outcome.raw_result);
      spans = resolveScreeningCitations(
        result,
        new Map(sent.map((u) => [u.utterance_id, u.text])),
        new Map(view.utterances.map((u) => [u.utterance_id, u.text])),
      );
    } catch (e) {
      if (e instanceof CiAnalysisValidationError) return this.retryOrPark(tenant_id, processing, e.code);
      throw e;
    }

    const cite = (i: number) =>
      (spans[i] ?? []).map((sp) => ({
        conversation_transcript_id: run.conversation_transcript_id,
        normalized_sha256: view.normalized_sha256,
        utterance_id: sp.utterance_id,
        start_offset: sp.start_offset,
        end_offset: sp.end_offset,
      }));

    // Drafts land in the screening domain FIRST, idempotent on the run id, so a
    // crash before completeRun converges on replay (never drafts twice).
    const sink = await this.screeningSink.saveDrafts({
      tenant_id,
      session_id: run.screening_session_id,
      run_id: run.id,
      provenance: {
        provider: run.model_provider,
        model: outcome.model_used,
        provider_request_id: outcome.model_request_id ?? null,
        prompt_version: `${CI_SCREENING_PROMPT_TEMPLATE_ID}.${CI_SCREENING_PROMPT_TEMPLATE_VERSION}`,
        input_sha256: outcome.input_sha256,
        used_talent_profile: ctx.context.talent_profile !== null,
        used_requisition: requisitionContext !== null,
      },
      findings: result.findings.map((f, i) => ({
        skill: f.skill,
        observation: f.observation,
        limitations: f.limitations,
        citations: cite(i),
      })),
    });
    if (sink === 'session_not_draft' || sink === 'session_not_found') {
      return this.toState(tenant_id, processing, 'failed_terminal', sink === 'session_not_draft'
        ? CI_PROCESSING_ERROR_CODES.SCREENING_SESSION_NOT_DRAFT
        : CI_PROCESSING_ERROR_CODES.SCREENING_SESSION_NOT_FOUND);
    }

    const claims: PersistClaimInput[] = result.findings.map((f, ordinal) => ({
      ordinal,
      claim_type: CI_SCREENING_CLAIM_TYPE,
      context_ref: null,
      statement: f.observation,
      status: 'SUPPORTED_BY_STATEMENT',
      citations: cite(ordinal),
    }));
    const completed = await this.repo.completeRun({
      tenantId: tenant_id,
      runId: processing.id,
      claims,
      draftSchemaVersion: CI_SCREENING_SCHEMA_VERSION,
      draftContent: { findings: result.findings.map((f) => ({ skill: f.skill, observation: f.observation, limitations: f.limitations })) },
    });
    return { outcome: 'completed', run: completed };
  }

  async process(command: ProcessConversationIntelligenceCommand): Promise<CiProcessingResult> {
    const { tenant_id, conversation_transcript_id, requisition_analysis_context_snapshot_id } = command;

    // 1. Load + verify the normalized transcript. Not-ready / not-found produce
    //    NO run and NO model call (directive test 6).
    const load = await this.transcripts.load(tenant_id, conversation_transcript_id);
    if (load.status === 'not_found') return { outcome: 'transcript_not_found' };
    if (load.status === 'not_ready') return { outcome: 'transcript_not_ready' };

    const meta = load.status === 'ready'
      ? { interaction_id: load.view.interaction_id, normalized_sha256: load.view.normalized_sha256 }
      : load.meta;

    const identity = this.model.modelIdentity();
    const provenance: CiRunProvenance = {
      tenant_id,
      conversation_transcript_id,
      requisition_analysis_context_snapshot_id,
      interaction_id: meta.interaction_id,
      normalized_sha256: meta.normalized_sha256,
      model_provider: identity.provider,
      model_name: identity.model,
      model_version: identity.version ?? null,
      prompt_template_id: CI_PROMPT_TEMPLATE_ID,
      prompt_template_version: CI_PROMPT_TEMPLATE_VERSION,
      prompt_sha256: CI_PROMPT_TEMPLATE_SHA256,
      output_schema_version: CI_ANALYSIS_SCHEMA_VERSION,
    };

    // 2. Find-or-create the run (analysis-identity key). A completed run is
    //    immutable → return it (idempotent; no re-invoke).
    const run = await this.repo.createOrGetQueued(provenance);
    if (run.status === 'completed') return { outcome: 'completed', run };

    // 3. Enter processing (from any re-drivable state).
    const processing = await this.transitionTo(tenant_id, run, 'processing', { started_at: new Date() });

    // 4. ai_processing authorization (independent, fail-closed) — BEFORE any model
    //    call (directive §4/§AI-consent). Denied → blocked (no model).
    const decision = await this.authz.evaluate({ tenant_id, interaction_id: meta.interaction_id });
    if (!decision.allowed) {
      if (decision.reason === 'no_talent') {
        return this.park(tenant_id, processing, CI_PROCESSING_ERROR_CODES.TALENT_ASSOCIATION_MISSING);
      }
      if (decision.reason === 'ambiguous_talent') {
        return this.toState(tenant_id, processing, 'intervention_required', CI_PROCESSING_ERROR_CODES.TALENT_ASSOCIATION_AMBIGUOUS);
      }
      return this.toState(tenant_id, processing, 'blocked_not_authorized', CI_PROCESSING_ERROR_CODES.AI_PROCESSING_NOT_AUTHORIZED);
    }

    // 5. Grounding integrity — fail closed, still no model call.
    if (load.status === 'artifact_not_found') {
      return this.toState(tenant_id, processing, 'failed_terminal', CI_PROCESSING_ERROR_CODES.NORMALIZED_ARTIFACT_NOT_FOUND);
    }
    if (load.status === 'hash_mismatch') {
      return this.toState(tenant_id, processing, 'failed_terminal', CI_PROCESSING_ERROR_CODES.NORMALIZED_HASH_MISMATCH);
    }
    const view: NormalizedTranscriptView = load.view;

    // 6. Immutable Requisition snapshot (never the mutable Requisition/profile).
    const snapshot = await this.snapshots.getSnapshot(tenant_id, requisition_analysis_context_snapshot_id);
    if (snapshot === null) {
      return this.toState(tenant_id, processing, 'failed_terminal', CI_PROCESSING_ERROR_CODES.REQUISITION_SNAPSHOT_NOT_FOUND);
    }

    // 7. Invoke the model (evidence-only input).
    const outcome = await this.model.generateStructuredAnalysis({
      tenant_id,
      conversation_transcript_id,
      normalized_transcript: view,
      requisition_context: snapshot.context,
      prompt_template_id: CI_PROMPT_TEMPLATE_ID,
      prompt_template_version: CI_PROMPT_TEMPLATE_VERSION,
      prompt_sha256: CI_PROMPT_TEMPLATE_SHA256,
      output_schema_version: CI_ANALYSIS_SCHEMA_VERSION,
    });
    if (outcome.kind === 'retryable_failure') {
      return this.retryOrPark(tenant_id, processing, outcome.error_code);
    }
    if (outcome.kind === 'terminal_failure') {
      return this.toState(tenant_id, processing, 'failed_terminal', outcome.error_code);
    }

    // 8. Strict structured-output validation + 9. citation validation (B6-owned).
    let result: AnalysisResultV1;
    try {
      result = validateAnalysisResult(outcome.raw_result);
      validateCitationsAgainstTranscript(result, view);
    } catch (e) {
      if (e instanceof CiAnalysisValidationError) {
        return this.retryOrPark(tenant_id, processing, e.code);
      }
      throw e;
    }

    // 10. Persist immutable claims + citations (coordinates only) + draft.
    const claims: PersistClaimInput[] = result.claims.map((c, ordinal) => ({
      ordinal,
      claim_type: c.claim_type,
      context_ref: c.context_ref ?? null,
      statement: c.statement,
      status: c.status,
      citations: c.citations.map((cit) => ({
        conversation_transcript_id,
        normalized_sha256: view.normalized_sha256,
        utterance_id: cit.utterance_id,
        start_offset: cit.start_offset ?? null,
        end_offset: cit.end_offset ?? null,
      })),
    }));
    const completed = await this.repo.completeRun({
      tenantId: tenant_id,
      runId: processing.id,
      claims,
      draftSchemaVersion: CI_ANALYSIS_SCHEMA_VERSION,
      draftContent: result.draft,
    });
    return { outcome: 'completed', run: completed };
  }

  private async transitionTo(
    tenantId: string,
    run: CiRunRow,
    to: ConversationIntelligenceRunStatus,
    patch: Partial<Pick<CiRunRow, 'started_at' | 'attempt_count' | 'last_error_code'>> = {},
  ): Promise<CiRunRow> {
    assertCiRunTransition(run.status, to);
    return this.repo.patchRun(tenantId, run.id, { status: to, ...patch });
  }

  private async toState(
    tenantId: string,
    run: CiRunRow,
    to: ConversationIntelligenceRunStatus,
    errorCode: string,
  ): Promise<CiProcessingResult> {
    assertCiRunTransition(run.status, to);
    const updated = await this.repo.patchRun(tenantId, run.id, { status: to, last_error_code: errorCode });
    return { outcome: to as CiProcessingOutcome, run: updated, error_code: errorCode };
  }

  private async park(tenantId: string, run: CiRunRow, errorCode: string): Promise<CiProcessingResult> {
    const updated = await this.repo.patchRun(tenantId, run.id, {
      status: 'failed_retryable',
      last_error_code: errorCode,
      attempt_count: run.attempt_count + 1,
    });
    return { outcome: 'failed_retryable', run: updated, error_code: errorCode };
  }

  private async retryOrPark(tenantId: string, run: CiRunRow, errorCode: string): Promise<CiProcessingResult> {
    const attempts = run.attempt_count + 1;
    const to: ConversationIntelligenceRunStatus =
      attempts >= CI_MAX_PROCESSING_ATTEMPTS ? 'intervention_required' : 'failed_retryable';
    assertCiRunTransition(run.status, to);
    const updated = await this.repo.patchRun(tenantId, run.id, {
      status: to,
      attempt_count: attempts,
      last_error_code: errorCode,
    });
    return { outcome: to as CiProcessingOutcome, run: updated, error_code: errorCode };
  }
}
