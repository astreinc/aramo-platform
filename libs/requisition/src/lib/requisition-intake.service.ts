import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { AiDraftService } from '@aramo/ai-draft';

import type { IntakeDraftResponseDto } from './dto/intake-generation.dto.js';
import {
  INTAKE_TEXT_MAX_CHARS,
  buildIntakePrompt,
  parseIntakeCompletion,
} from './intake-prompt.js';

// New Requisition AI intake service — the PRE-CREATION generation path
// (charter §7.3, Lead ruling Tab 1). Unlike the per-requisition profile
// draft (/:id/profile/draft, which needs an existing req), this drafts a
// requisition FROM SCRATCH: intake text → extracted fields + JD + must/nice
// requirement skills, returned for the recruiter to review/edit/commit. It
// mutates NOTHING — the AI never saves (R8/R12); the recruiter commits via
// the normal create flow.
//
// 2nd declared libs/ai-draft consumer (same lib as RequisitionProfileService;
// ADR-0015 v1.2 — no new amendment). Reuses AiDraftService.generateDraft (the
// model/key/audit/PII-redaction/no-raw-logging are all inside ai-draft).
//
// HONEST FAILURE (Lead ruling): there is NO fake/mock draft fallback. If the
// AI provider is unavailable — the provider call fails OR its API key cannot
// be resolved (the key lives out-of-band in AWS Secrets Manager, like the
// Cognito/S3 creds) — this service REMAPS the raw INTERNAL_ERROR to the
// honest AI_PROVIDER_UNAVAILABLE (502) / AI_RATE_LIMITED (429) codes (the
// inline remap the engagement draft endpoint established — there is no global
// filter that does it). The FE then renders an honest "AI drafting
// unavailable — enter it manually" state; we never fabricate a draft.

const DEFAULT_MAX_TOKENS = 1536;

@Injectable()
export class RequisitionIntakeService {
  constructor(private readonly aiDraftService: AiDraftService) {}

  async draftFromIntake(args: {
    tenant_id: string;
    intake_text: string;
    max_tokens?: number;
    requestId: string;
  }): Promise<IntakeDraftResponseDto> {
    const text = args.intake_text;
    if (text.trim().length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'intake_text must be non-empty', 400, {
        requestId: args.requestId,
        details: { field: 'intake_text' },
      });
    }
    if (text.length > INTAKE_TEXT_MAX_CHARS) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `intake_text must be at most ${INTAKE_TEXT_MAX_CHARS} characters`,
        400,
        {
          requestId: args.requestId,
          details: {
            field: 'intake_text',
            reason: 'intake_text_too_long',
            max_chars: INTAKE_TEXT_MAX_CHARS,
          },
        },
      );
    }

    const { prompt, system_message } = buildIntakePrompt(text);

    // No fake fallback — a provider/key failure is remapped to an honest
    // AI_* code (mirrors the engagement draft endpoint's remap). Anything the
    // ai-draft substrate raises on the failure path is an INTERNAL_ERROR
    // (provider transport / auth / vendor-internal, OR the secret-cache's
    // key-resolution failure: env_missing / secret_not_found / aws_*) — all
    // mean the AI lane cannot draft → AI_PROVIDER_UNAVAILABLE. A rate-limit
    // is the one distinct case → AI_RATE_LIMITED. A VALIDATION_ERROR (the
    // provider rejecting the request shape) passes through unchanged.
    let result: Awaited<ReturnType<typeof this.aiDraftService.generateDraft>>;
    try {
      result = await this.aiDraftService.generateDraft({
        tenant_id: args.tenant_id,
        prompt,
        max_tokens: args.max_tokens ?? DEFAULT_MAX_TOKENS,
        system_message,
        requestId: args.requestId,
      });
    } catch (err) {
      throw this.remapProviderError(err, args.requestId);
    }

    const parsed = parseIntakeCompletion(result.completion);
    return {
      fields: parsed.fields,
      jd_text: parsed.jd_text,
      required_skills: parsed.required_skills,
      nice_to_have_skills: parsed.nice_to_have_skills,
      ai_draft_audit_record_id: result.audit_record_id,
    };
  }

  // Remap the ai-draft substrate's raw error to an honest, FE-facing AI_*
  // code (the engagement draft endpoint's inline-remap precedent — there is
  // no global filter). This method only ever sees a generateDraft() failure
  // (the recruiter-input validation — empty / over-length — throws BEFORE the
  // try-block), so EVERY error here is provider-side:
  //   - provider_rate_limited → AI_RATE_LIMITED (429).
  //   - INTERNAL_ERROR (provider transport/auth/vendor + the secret-cache's
  //     key-resolution failure) → AI_PROVIDER_UNAVAILABLE (502).
  //   - VALIDATION_ERROR with kind 'provider_input_invalid' → ALSO
  //     AI_PROVIDER_UNAVAILABLE. Anthropic returns account/billing problems
  //     (e.g. "credit balance too low") + model-access denials as a 400
  //     invalid_request_error, which the provider adapter maps to
  //     VALIDATION_ERROR. Surfacing that to the recruiter as a 400 would
  //     mis-blame THEIR text ("try a shorter note") — but the input was
  //     already validated upstream, so this is the AI lane being unavailable,
  //     not bad input. (A genuine VALIDATION_ERROR from the recruiter's input
  //     is thrown earlier and never reaches here.)
  private remapProviderError(err: unknown, requestId: string): unknown {
    if (err instanceof AramoError) {
      const kind = (err.context.details?.['kind'] as string | undefined) ?? null;
      if (err.code === 'INTERNAL_ERROR' && kind === 'provider_rate_limited') {
        return new AramoError('AI_RATE_LIMITED', 'AI provider rate-limited', 429, {
          requestId,
          details: { kind },
        });
      }
      if (
        err.code === 'INTERNAL_ERROR' ||
        (err.code === 'VALIDATION_ERROR' && kind === 'provider_input_invalid')
      ) {
        return new AramoError(
          'AI_PROVIDER_UNAVAILABLE',
          'AI drafting is unavailable',
          502,
          { requestId, details: { kind: kind ?? 'unknown' } },
        );
      }
    }
    return err;
  }
}
