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
// provider binding is unavailable the generateDraft call throws (the api
// error filter remaps it to AI_PROVIDER_UNAVAILABLE 502 / AI_RATE_LIMITED
// 429) and the FE renders an honest failure state — we never fabricate a
// draft.

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

    // No fake fallback — a provider failure propagates (AI_PROVIDER_UNAVAILABLE).
    const result = await this.aiDraftService.generateDraft({
      tenant_id: args.tenant_id,
      prompt,
      max_tokens: args.max_tokens ?? DEFAULT_MAX_TOKENS,
      system_message,
      requestId: args.requestId,
    });

    const parsed = parseIntakeCompletion(result.completion);
    return {
      fields: parsed.fields,
      jd_text: parsed.jd_text,
      required_skills: parsed.required_skills,
      nice_to_have_skills: parsed.nice_to_have_skills,
      ai_draft_audit_record_id: result.audit_record_id,
    };
  }
}
