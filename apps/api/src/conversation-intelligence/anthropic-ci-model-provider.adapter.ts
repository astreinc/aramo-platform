import { Inject, Injectable } from '@nestjs/common';
import {
  STRUCTURED_GENERATION_PROVIDER,
  type StructuredGenerationErrorCategory,
  type StructuredGenerationProvider,
} from '@aramo/ai-draft';
import {
  CI_ANALYSIS_JSON_SCHEMA,
  CI_ANALYSIS_JSON_SCHEMA_NAME,
  CI_PROCESSING_ERROR_CODES,
  CI_PROMPT_TEMPLATE_TEXT,
  type ConversationIntelligenceModelProvider,
  type ModelAnalysisInput,
  type ModelAnalysisOutcome,
  type NormalizedTranscriptView,
} from '@aramo/conversation-intelligence';

import { CI_MODEL_MAX_OUTPUT_TOKENS, CiProcessingConfig } from './ci-processing.config.js';

// CI-B6P §11 — the production adapter that binds the provider-neutral CI model
// port to the sanctioned Anthropic infrastructure (via the ai-draft
// structured-generation surface). This file is Anthropic-NAME-bearing only in
// its intent; it imports NO @anthropic-ai/sdk type — the SDK stays inside
// libs/ai-draft. The CI domain never sees a vendor object.
//
// It:
//   - builds the model input from the EVIDENCE UNIVERSE only (minimized
//     transcript utterances + immutable Requisition context) — directive §12/§13;
//   - hands the domain-owned analysis.v1 JSON Schema for native structured
//     output — directive §8;
//   - returns a RAW parsed object (unknown) — the B6 validator + citation
//     validator remain authoritative (directive §25);
//   - maps safe provider categories to the B6 error taxonomy (no raw text).
@Injectable()
export class AnthropicConversationIntelligenceAdapter implements ConversationIntelligenceModelProvider {
  constructor(
    @Inject(STRUCTURED_GENERATION_PROVIDER)
    private readonly generation: StructuredGenerationProvider,
    private readonly config: CiProcessingConfig,
  ) {}

  providerKey(): string {
    return this.generation.providerKey();
  }

  modelIdentity(): { provider: string; model: string; version?: string } {
    // Fail-closed if unset/non-allowlisted (callers gate on activation first).
    return { provider: this.generation.providerKey(), model: this.config.resolveModel() };
  }

  async generateStructuredAnalysis(input: ModelAnalysisInput): Promise<ModelAnalysisOutcome> {
    const model = this.config.resolveModel();
    const outcome = await this.generation.generateStructured({
      model,
      system: CI_PROMPT_TEMPLATE_TEXT,
      user_content: this.buildEvidencePayload(input),
      max_tokens: CI_MODEL_MAX_OUTPUT_TOKENS,
      json_schema: { ...CI_ANALYSIS_JSON_SCHEMA },
      schema_name: CI_ANALYSIS_JSON_SCHEMA_NAME,
    });

    if (outcome.kind === 'ok') {
      const transport = outcome.transport;
      return transport.provider_request_id !== undefined
        ? { kind: 'ok', raw_result: outcome.parsed, model_request_id: transport.provider_request_id }
        : { kind: 'ok', raw_result: outcome.parsed };
    }
    const error_code = mapCategoryToErrorCode(outcome.category);
    return outcome.kind === 'retryable'
      ? { kind: 'retryable_failure', error_code }
      : { kind: 'terminal_failure', error_code };
  }

  /**
   * MINIMIZED evidence (directive §13): only the immutable Requisition context
   * and the transcript utterances the model needs — canonical speaker ROLE +
   * utterance id + text. No names, phone, email, timing, storage refs, tokens,
   * or webhook payload.
   */
  private buildEvidencePayload(input: ModelAnalysisInput): string {
    const transcript: NormalizedTranscriptView = input.normalized_transcript;
    const payload = {
      task: 'Analyze the conversation against the requisition context and produce the analysis.v1 result.',
      output_schema_version: input.output_schema_version,
      requisition_context: input.requisition_context,
      transcript: {
        utterances: transcript.utterances.map((u) => ({
          utterance_id: u.utterance_id,
          speaker_role: u.speaker_role,
          text: u.text,
        })),
      },
    };
    return JSON.stringify(payload);
  }
}

function mapCategoryToErrorCode(category: StructuredGenerationErrorCategory): string {
  switch (category) {
    case 'rate_limited':
      return CI_PROCESSING_ERROR_CODES.MODEL_RATE_LIMITED;
    case 'timeout':
      return CI_PROCESSING_ERROR_CODES.MODEL_TIMEOUT;
    case 'server_error':
    case 'network':
    case 'transport':
    case 'auth_config':
      return CI_PROCESSING_ERROR_CODES.MODEL_PROVIDER_UNAVAILABLE;
    case 'malformed_output':
    case 'empty_output':
      return CI_PROCESSING_ERROR_CODES.MODEL_OUTPUT_INVALID;
    case 'invalid_request':
      return CI_PROCESSING_ERROR_CODES.MODEL_OUTPUT_SCHEMA_MISMATCH;
    default:
      return CI_PROCESSING_ERROR_CODES.MODEL_PROVIDER_UNAVAILABLE;
  }
}
