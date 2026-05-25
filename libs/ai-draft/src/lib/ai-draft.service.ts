import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';

import { AiDraftRepository } from './ai-draft.repository.js';
import { ARAMO_AI_DRAFT_MODEL } from './dto/event-payloads.js';
import type { GenerateDraftInput } from './dto/generate-draft-input.dto.js';
import type { GenerateDraftResult } from './dto/generate-draft-result.dto.js';
import type { DraftProvider } from './providers/draft-provider.interface.js';
import { DRAFT_PROVIDER_TOKEN } from './providers/tokens.js';
import { redactPii } from './redaction.js';
import { SecretCacheService } from './secrets/secret-cache.service.js';

// M5 PR-5 §4.10 — AiDraftService orchestrator. The single substrate
// entrypoint per ADR-0015. Responsibilities (10 ordered steps):
//   1. Input validation.
//   2. Pre-redaction + prompt sha256 + token estimate.
//   3. appendEvent(request_built).
//   4. appendEvent(request_sent).
//   5. provider.generate() call boundary + duration timing.
//   6. Post-redaction + completion sha256.
//   7. appendEvent(response_received).
//   8/9. Optional appendEvent(redaction_applied) per pre/post counts.
//  10. Project GenerateDraftResult.
//
// Error path: any throw from provider.generate or repository.appendEvent
// is captured and re-emitted as appendEvent(error_raised) followed by
// re-throw as AramoError. Per ADR-0015 Decision 6: the substrate is
// resilient to provider failures (errors are observable in the event
// log) but does NOT swallow them — callers see the AramoError.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(s: string): boolean {
  return UUID_RE.test(s);
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

@Injectable()
export class AiDraftService {
  constructor(
    @Inject(DRAFT_PROVIDER_TOKEN) private readonly provider: DraftProvider,
    private readonly secretCache: SecretCacheService,
    private readonly repository: AiDraftRepository,
    @Inject('AiDraftServiceLogger') private readonly logger: AramoLogger,
  ) {}

  async generateDraft(input: GenerateDraftInput): Promise<GenerateDraftResult> {
    const requestIdTag = input.requestId ?? 'ai-draft-service';

    // -- Step 1: Validate input ----------------------------------------
    if (!isValidUuid(input.tenant_id)) {
      throw new AramoError('VALIDATION_ERROR', 'tenant_id must be a UUID', 400, {
        requestId: requestIdTag,
        details: { field: 'tenant_id' },
      });
    }
    if (input.prompt.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'prompt must be non-empty', 400, {
        requestId: requestIdTag,
        details: { field: 'prompt' },
      });
    }
    if (!Number.isInteger(input.max_tokens) || input.max_tokens <= 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'max_tokens must be a positive integer',
        400,
        { requestId: requestIdTag, details: { field: 'max_tokens' } },
      );
    }

    const model = input.model ?? ARAMO_AI_DRAFT_MODEL;

    // -- Step 2: Pre-redaction + prompt hash --------------------------
    const redactedInput = redactPii(input.prompt);
    const prompt_sha256 = sha256Hex(redactedInput.redactedText);
    const prompt_token_estimate = estimateTokens(redactedInput.redactedText);

    // -- Step 3: request_built event ----------------------------------
    const audit_record_id = randomUUID();
    try {
      await this.repository.appendEvent({
        id: audit_record_id,
        tenant_id: input.tenant_id,
        event_type: 'request_built',
        event_payload: {
          model,
          prompt_sha256,
          prompt_token_estimate,
          max_tokens: input.max_tokens,
          redacted_span_count_input: redactedInput.spanCount,
        },
      });
    } catch (err) {
      throw this.wrapError(err, requestIdTag, 'request_built');
    }

    // -- Step 4: request_sent event -----------------------------------
    try {
      await this.repository.appendEvent({
        id: randomUUID(),
        tenant_id: input.tenant_id,
        event_type: 'request_sent',
        event_payload: { model, retry_attempt: 0 },
      });
    } catch (err) {
      throw this.wrapError(err, requestIdTag, 'request_sent');
    }

    // -- Step 5: provider call ----------------------------------------
    const startMs = Date.now();
    let providerResult;
    try {
      providerResult = await this.provider.generate({
        model,
        prompt: redactedInput.redactedText,
        max_tokens: input.max_tokens,
        ...(input.system_message !== undefined
          ? { system_message: input.system_message }
          : {}),
      });
    } catch (err) {
      await this.emitErrorRaised(input.tenant_id, 'response_received', err);
      throw this.wrapError(err, requestIdTag, 'response_received');
    }

    // -- Step 6: post-redaction + completion hash ---------------------
    const durationMs = Date.now() - startMs;
    const redactedOutput = redactPii(providerResult.completion);
    const completion_sha256 = sha256Hex(redactedOutput.redactedText);

    // -- Step 7: response_received event ------------------------------
    try {
      await this.repository.appendEvent({
        id: randomUUID(),
        tenant_id: input.tenant_id,
        event_type: 'response_received',
        event_payload: {
          model_used: providerResult.model_used,
          input_tokens: providerResult.input_tokens,
          output_tokens: providerResult.output_tokens,
          duration_ms: durationMs,
          completion_sha256,
          redacted_span_count_output: redactedOutput.spanCount,
        },
      });
    } catch (err) {
      throw this.wrapError(err, requestIdTag, 'response_received');
    }

    // -- Step 8: redaction_applied (pre_prompt) -----------------------
    if (redactedInput.spanCount > 0) {
      try {
        await this.repository.appendEvent({
          id: randomUUID(),
          tenant_id: input.tenant_id,
          event_type: 'redaction_applied',
          event_payload: {
            kind: 'pre_prompt',
            count: redactedInput.spanCount,
            hashed_input_ref: prompt_sha256,
          },
        });
      } catch (err) {
        throw this.wrapError(err, requestIdTag, 'redaction');
      }
    }

    // -- Step 9: redaction_applied (post_completion) ------------------
    if (redactedOutput.spanCount > 0) {
      try {
        await this.repository.appendEvent({
          id: randomUUID(),
          tenant_id: input.tenant_id,
          event_type: 'redaction_applied',
          event_payload: {
            kind: 'post_completion',
            count: redactedOutput.spanCount,
            hashed_input_ref: completion_sha256,
          },
        });
      } catch (err) {
        throw this.wrapError(err, requestIdTag, 'redaction');
      }
    }

    this.logger.log({
      event: 'ai_draft.generated',
      tenant_id: input.tenant_id,
      audit_record_id,
      duration_ms: durationMs,
      model_used: providerResult.model_used,
      input_tokens: providerResult.input_tokens,
      output_tokens: providerResult.output_tokens,
      redacted_span_count_input: redactedInput.spanCount,
      redacted_span_count_output: redactedOutput.spanCount,
    });

    // -- Step 10: project result --------------------------------------
    return {
      completion: redactedOutput.redactedText,
      model_used: providerResult.model_used,
      input_tokens: providerResult.input_tokens,
      output_tokens: providerResult.output_tokens,
      duration_ms: durationMs,
      audit_record_id,
    };
  }

  private async emitErrorRaised(
    tenant_id: string,
    stage: 'request_built' | 'request_sent' | 'response_received' | 'redaction',
    err: unknown,
  ): Promise<void> {
    const aramoCode =
      err instanceof AramoError ? err.code : 'INTERNAL_ERROR';
    const kind =
      err instanceof AramoError
        ? ((err.context.details?.['kind'] as string | undefined) ?? 'unknown')
        : 'unknown';
    const message = err instanceof Error ? err.message : String(err);
    try {
      await this.repository.appendEvent({
        id: randomUUID(),
        tenant_id,
        event_type: 'error_raised',
        event_payload: {
          stage,
          error_code: aramoCode,
          kind,
          message,
        },
      });
    } catch (emitErr) {
      this.logger.error({
        event: 'ai_draft.error_event_emit_failed',
        tenant_id,
        stage,
        error_message: emitErr instanceof Error ? emitErr.message : String(emitErr),
      });
    }
  }

  private wrapError(err: unknown, requestId: string, stage: string): AramoError {
    if (err instanceof AramoError) {
      return new AramoError(err.code, err.message, err.statusCode, {
        requestId,
        details: { ...err.context.details, stage },
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return new AramoError('INTERNAL_ERROR', message, 500, {
      requestId,
      details: { stage, kind: 'unexpected_error' },
    });
  }
}
