// TIP-E2E INC-3 A1-5 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part D.1/D.2/D.3) —
// the screening-profile seams. The CI lib never imports the screening domain
// (cross-domain composition stays in apps/api); the composition root binds:
//   - the screening context (exactly-one session → exactly-one Talent; the
//     question plan, recruiter notes, minimized profile, optional snapshot);
//   - the draft sink (AI-drafted findings land as DRAFT review items in the
//     screening domain — recruiter review happens there, not in B7 tables);
//   - the screening model call through the tenant-selected provider.

import type { ModelAnalysisOutcome } from '../model/conversation-intelligence-model-provider.port.js';

import type { NormalizedTranscriptView } from './normalized-transcript-source.port.js';

export interface ScreeningAnalysisContext {
  readonly session_id: string;
  readonly talent_record_id: string;
  /** The meeting interaction the session is linked to (must equal the transcript's). */
  readonly interaction_id: string | null;
  readonly question_plan: readonly string[];
  readonly recruiter_notes: readonly string[];
  readonly talent_profile: unknown | null;
}

export type ScreeningContextLoad =
  | { readonly status: 'ready'; readonly context: ScreeningAnalysisContext }
  | { readonly status: 'not_found' }
  | { readonly status: 'not_draft' };

export interface ScreeningAnalysisContextSource {
  load(tenantId: string, sessionId: string): Promise<ScreeningContextLoad>;
}

export interface ScreeningFindingDraft {
  readonly skill: string;
  readonly observation: string;
  readonly limitations: string | null;
  readonly citations: readonly {
    readonly conversation_transcript_id: string;
    readonly normalized_sha256: string;
    readonly utterance_id: string;
    readonly start_offset: number;
    readonly end_offset: number;
  }[];
}

export type ScreeningDraftSinkResult = 'saved' | 'replayed' | 'session_not_draft' | 'session_not_found';

export interface ScreeningFindingDraftSink {
  saveDrafts(input: {
    tenant_id: string;
    session_id: string;
    run_id: string;
    provenance: {
      provider: string;
      model: string;
      provider_request_id: string | null;
      prompt_version: string;
      input_sha256: string;
      used_talent_profile: boolean;
      used_requisition: boolean;
    };
    findings: readonly ScreeningFindingDraft[];
  }): Promise<ScreeningDraftSinkResult>;
}

export interface ScreeningModelInput {
  readonly tenant_id: string;
  readonly conversation_transcript_id: string;
  /** Utterances AS SENT (redacted). Citations are validated against these. */
  readonly utterances: readonly { utterance_id: string; speaker_role: string; text: string }[];
  readonly context: ScreeningAnalysisContext;
  readonly requisition_context: unknown | null;
}

export type ScreeningModelOutcome =
  | (Extract<ModelAnalysisOutcome, { kind: 'ok' }> & { readonly model_used: string; readonly input_sha256: string })
  | Exclude<ModelAnalysisOutcome, { kind: 'ok' }>;

export interface ScreeningAnalysisModel {
  /** The tenant-selected provider + the model it will be asked for (run identity). */
  modelIdentity(tenantId: string): Promise<{ provider: string; model: string }>;
  /** Redact the transcript for sending (the same redaction the model input receives). */
  redactUtterances(view: NormalizedTranscriptView): { utterance_id: string; speaker_role: string; text: string }[];
  generate(input: ScreeningModelInput): Promise<ScreeningModelOutcome>;
}

export const SCREENING_ANALYSIS_CONTEXT_SOURCE = 'CI_SCREENING_ANALYSIS_CONTEXT_SOURCE';
export const SCREENING_FINDING_DRAFT_SINK = 'CI_SCREENING_FINDING_DRAFT_SINK';
export const SCREENING_ANALYSIS_MODEL = 'CI_SCREENING_ANALYSIS_MODEL';
