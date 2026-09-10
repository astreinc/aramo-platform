// CI-B6 — the provider-neutral AI model port. B6 owns validation: the provider
// returns a RAW structured object (`unknown`), and the processing service runs
// the strict schema + citation validators. No OpenAI/Anthropic/AWS shape leaks
// into the domain. The port never returns hidden reasoning / chain-of-thought.

import type { NormalizedTranscriptView } from '../ports/normalized-transcript-source.port.js';

/** Controlled, typed input — only the evidence the model is permitted to use. */
export interface ModelAnalysisInput {
  readonly tenant_id: string;
  readonly conversation_transcript_id: string;
  readonly normalized_transcript: NormalizedTranscriptView;
  /** Immutable B2 Requisition analysis context (the snapshot's `context` JSON). */
  readonly requisition_context: unknown;
  readonly prompt_template_id: string;
  readonly prompt_template_version: string;
  readonly prompt_sha256: string;
  readonly output_schema_version: string;
}

/** Discriminated outcome — retryable vs terminal failures carry safe codes only. */
export type ModelAnalysisOutcome =
  | { readonly kind: 'ok'; readonly raw_result: unknown; readonly model_request_id?: string }
  | { readonly kind: 'retryable_failure'; readonly error_code: string }
  | { readonly kind: 'terminal_failure'; readonly error_code: string };

export interface ConversationIntelligenceModelProvider {
  providerKey(): string;
  modelIdentity(): { provider: string; model: string; version?: string };
  generateStructuredAnalysis(input: ModelAnalysisInput): Promise<ModelAnalysisOutcome>;
}

/** DI token — the concrete provider is bound at the composition root. */
export const CONVERSATION_INTELLIGENCE_MODEL_PROVIDER = 'CONVERSATION_INTELLIGENCE_MODEL_PROVIDER';
