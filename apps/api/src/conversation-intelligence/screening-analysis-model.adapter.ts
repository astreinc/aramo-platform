import { createHash } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  ACTIVE_PROVIDER_RESOLVER,
  STRUCTURED_GENERATION_PROVIDER,
  redactPii,
  resolveProviderModel,
  type ActiveProviderResolver,
  type StructuredGenerationProvider,
} from '@aramo/ai-draft';
import {
  CI_SCREENING_JSON_SCHEMA,
  CI_SCREENING_JSON_SCHEMA_NAME,
  CI_SCREENING_PROMPT_TEMPLATE_TEXT,
  CI_SCREENING_SCHEMA_VERSION,
  type NormalizedTranscriptView,
  type ScreeningAnalysisModel,
  type ScreeningModelInput,
  type ScreeningModelOutcome,
} from '@aramo/conversation-intelligence';

import { mapCategoryToErrorCode } from './anthropic-ci-model-provider.adapter.js';
import { CI_MODEL_MAX_OUTPUT_TOKENS, CiProcessingConfig } from './ci-processing.config.js';

// TIP-E2E INC-3 A1-5 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part D.2, Part G) — the
// screening-profile model binding. Differences from the CI-B6 adapter, each
// required by the amendment:
//   - the TENANT-SELECTED provider (TENANT-LLM-2 Phase A), never a fixed vendor;
//     no fallback across providers (the dispatcher resolves exactly one);
//   - provenance is the provider + model ACTUALLY used (transport.model_used);
//   - explicit pre-send redaction (redactPii) of every free-text field,
//     transcript utterances included — the structured path does not redact;
//   - the evidence universe adds the question plan, recruiter notes and the
//     minimized profile (D.2); no external retrieval, no prior conversations.
function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactPii(value).redactedText;
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

@Injectable()
export class ScreeningAnalysisModelAdapter implements ScreeningAnalysisModel {
  constructor(
    @Inject(STRUCTURED_GENERATION_PROVIDER) private readonly generation: StructuredGenerationProvider,
    private readonly config: CiProcessingConfig,
    @Optional() @Inject(ACTIVE_PROVIDER_RESOLVER) private readonly providers?: ActiveProviderResolver,
  ) {}

  async modelIdentity(tenantId: string): Promise<{ provider: string; model: string }> {
    const provider = this.providers !== undefined ? await this.providers.resolveActiveProvider(tenantId) : 'anthropic';
    return { provider, model: resolveProviderModel(provider, this.config.resolveModel()) };
  }

  redactUtterances(view: NormalizedTranscriptView): { utterance_id: string; speaker_role: string; text: string }[] {
    return view.utterances.map((u) => ({
      utterance_id: u.utterance_id,
      speaker_role: u.speaker_role,
      text: redactPii(u.text).redactedText,
    }));
  }

  async generate(input: ScreeningModelInput): Promise<ScreeningModelOutcome> {
    const payload = JSON.stringify({
      task: 'Draft screening findings from this interview transcript for recruiter review.',
      output_schema_version: CI_SCREENING_SCHEMA_VERSION,
      screening_context: redact({
        question_plan: input.context.question_plan,
        recruiter_notes: input.context.recruiter_notes,
        talent_profile: input.context.talent_profile,
      }),
      requisition_context: input.requisition_context === null ? null : redact(input.requisition_context),
      transcript: { utterances: input.utterances },
    });
    const input_sha256 = createHash('sha256').update(payload, 'utf8').digest('hex');
    const outcome = await this.generation.generateStructured({
      tenant_id: input.tenant_id,
      model: this.config.resolveModel(),
      system: CI_SCREENING_PROMPT_TEMPLATE_TEXT,
      user_content: payload,
      max_tokens: CI_MODEL_MAX_OUTPUT_TOKENS,
      json_schema: { ...CI_SCREENING_JSON_SCHEMA },
      schema_name: CI_SCREENING_JSON_SCHEMA_NAME,
    });
    if (outcome.kind === 'ok') {
      const t = outcome.transport;
      return {
        kind: 'ok',
        raw_result: outcome.parsed,
        model_used: t.model_used,
        input_sha256,
        ...(t.provider_request_id !== undefined ? { model_request_id: t.provider_request_id } : {}),
      };
    }
    const error_code = mapCategoryToErrorCode(outcome.category);
    return outcome.kind === 'retryable' ? { kind: 'retryable_failure', error_code } : { kind: 'terminal_failure', error_code };
  }
}
