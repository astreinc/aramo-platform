import { createHash } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  ACTIVE_PROVIDER_RESOLVER,
  STRUCTURED_GENERATION_PROVIDER,
  redactPii,
  type ActiveProviderResolver,
  type StructuredGenerationOutcome,
  type StructuredGenerationProvider,
} from '@aramo/ai-draft';

import {
  ScreeningGuardError,
  TechnicalScreeningRepository,
  type AiGenerationInput,
  type ScreeningQuestionRow,
  type ScreeningSuggestionRow,
} from '../technical-screening.repository.js';
import { SCREENING_QUESTION_MAX } from '../screening-vocab.js';

import {
  SCREENING_AI_CONSENT,
  type ScreeningAiConsentPort,
  type ScreeningRequisitionContext,
  type ScreeningTalentContext,
} from './screening-ai.ports.js';

// TIP-E2E INC-3 A1-3 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED §B.3, §B.4, Part G, R-A).
// Recruiter-controlled AI assistance through the TENANT LLM (TENANT-LLM-2 Phase A
// providers, the tenant's own key) via the shared structured-generation port —
// never a second engine, never streaming, fixed versioned prompts and strict JSON
// schemas, per-tenant prompt customization out of scope. Every string sent to a
// provider is redacted with the existing pre-send boundary (redactPii). R-A:
// whenever Talent-profile content (or interview notes about the talent) is sent,
// the existing `ai_processing` authorization is required — fail closed.
// Outputs are drafts / suggestions only: nothing here confirms a finding, orders
// talent, or states any requisition fit.

export const SCREENING_AI_MODEL = 'claude-sonnet-4-6';
export const QUESTION_PLAN_PROMPT_VERSION = 'inc3-a1.question-plan.v1';
export const FOLLOW_UP_PROMPT_VERSION = 'inc3-a1.follow-up.v1';
const QUESTION_PLAN_MAX = 12;
const FOLLOW_UP_MAX = 3;

const QUESTION_PLAN_SYSTEM = [
  'You help a recruiter who may not have a technical background prepare a technical screening interview.',
  'Write clear, open technical interview questions that let the interviewee show what they actually know.',
  'Ground every question in the provided role requirements and the interviewee profile claims.',
  'Prefer questions that ask the interviewee to explain, walk through, or compare concrete work.',
  'Do NOT judge or predict suitability, fit, seniority or likelihood of success. Do NOT order or compare people.',
  'Do NOT ask about age, family, health, religion, nationality, ethnicity, gender, disability or any other protected characteristic.',
  'Return only the JSON object required by the schema.',
].join(' ');

const FOLLOW_UP_SYSTEM = [
  'You help a recruiter during a technical screening interview.',
  'Given the interview plan and the recruiter notes or conversation excerpt, suggest up to three short follow-up questions that would clarify or deepen what the interviewee said.',
  'Suggestions are optional prompts for the recruiter, never conclusions.',
  'Do NOT state whether an answer is right, wrong, strong or weak. Do NOT judge suitability or fit.',
  'Do NOT ask about any protected characteristic.',
  'Return only the JSON object required by the schema.',
].join(' ');

const QUESTION_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      maxItems: QUESTION_PLAN_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'skill_ref'],
        properties: {
          text: { type: 'string' },
          skill_ref: { type: ['string', 'null'] },
        },
      },
    },
  },
};

const FOLLOW_UP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: { type: 'array', maxItems: FOLLOW_UP_MAX, items: { type: 'string' } },
  },
};

// Redact every string in a JSON-ish value with the existing pre-send boundary.
function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactPii(value).redactedText;
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t.slice(0, max) : null;
}

@Injectable()
export class ScreeningAiService {
  constructor(
    private readonly repo: TechnicalScreeningRepository,
    @Inject(STRUCTURED_GENERATION_PROVIDER) private readonly llm: StructuredGenerationProvider,
    @Inject(SCREENING_AI_CONSENT) private readonly consent: ScreeningAiConsentPort,
    @Optional() @Inject(ACTIVE_PROVIDER_RESOLVER) private readonly providers?: ActiveProviderResolver,
  ) {}

  // §B.3 / G-1 + G-2 — generate (or regenerate) the session question plan.
  async generateQuestionPlan(input: {
    tenant_id: string;
    session_id: string;
    talent_record_id: string;
    actor_id: string;
    requisition: ScreeningRequisitionContext | null;
    talent: ScreeningTalentContext | null;
    requestId: string;
  }): Promise<{ generation_id: string; questions: ScreeningQuestionRow[] }> {
    if (input.requisition === null && input.talent === null) {
      throw new AramoError('VALIDATION_ERROR', 'question generation needs requisition or talent context', 400, {
        requestId: input.requestId,
      });
    }
    // R-A — Talent-profile content requires ai_processing (fail closed).
    if (input.talent !== null) await this.assertAiProcessing(input.tenant_id, input.talent_record_id, input.requestId);

    const userContent = JSON.stringify(
      redactDeep({
        role_requirements: input.requisition,
        interviewee_profile: input.talent,
        instructions: `Return between 5 and ${QUESTION_PLAN_MAX} questions.`,
      }),
    );
    const outcome = await this.llm.generateStructured({
      tenant_id: input.tenant_id,
      model: SCREENING_AI_MODEL,
      system: QUESTION_PLAN_SYSTEM,
      user_content: userContent,
      max_tokens: 2000,
      json_schema: QUESTION_PLAN_SCHEMA,
      schema_name: 'screening_question_plan',
    });
    const ok = this.unwrap(outcome, input.requestId);
    const parsed = (ok.parsed ?? {}) as { questions?: Array<{ text?: unknown; skill_ref?: unknown }> };
    const questions = (parsed.questions ?? [])
      .map((q) => ({
        text: cleanText(q.text, SCREENING_QUESTION_MAX),
        skill_ref: cleanText(q.skill_ref, 200),
      }))
      .filter((q): q is { text: string; skill_ref: string | null } => q.text !== null)
      .slice(0, QUESTION_PLAN_MAX)
      .map((q) => ({ ...q, intent: 'PROBE' }));
    if (questions.length === 0) {
      throw new AramoError('SCREENING_AI_UNAVAILABLE', 'the model returned no usable questions; try again', 503, {
        requestId: input.requestId,
      });
    }
    const generation = await this.provenance(input.tenant_id, ok.transport, {
      kind: 'QUESTION_PLAN',
      prompt_version: QUESTION_PLAN_PROMPT_VERSION,
      input_sha256: sha256(userContent),
      used_talent_profile: input.talent !== null,
      used_requisition: input.requisition !== null,
      used_transcript: false,
    });
    return this.guarded(input.requestId, () =>
      this.repo.saveQuestionPlan({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        actor_id: input.actor_id,
        generation,
        questions,
      }),
    );
  }

  // §B.4 / G-4 (recruiter notes) and C-2 (approved live transcript segments) —
  // advisory follow-up suggestions. Always ai_processing-gated: interview notes
  // and conversation content are about the talent (R-A, §5).
  async suggestFollowUps(input: {
    tenant_id: string;
    session_id: string;
    talent_record_id: string;
    actor_id: string;
    trigger:
      | { kind: 'NOTE'; note_id: string; text: string }
      | { kind: 'TRANSCRIPT_SEGMENTS'; segment_ids: string[]; text: string };
    plan: string[];
    requestId: string;
  }): Promise<ScreeningSuggestionRow[]> {
    await this.assertAiProcessing(input.tenant_id, input.talent_record_id, input.requestId);
    const userContent = JSON.stringify(
      redactDeep({
        interview_plan: input.plan.slice(0, 20),
        latest: { source: input.trigger.kind === 'NOTE' ? 'recruiter_note' : 'conversation_excerpt', text: input.trigger.text },
      }),
    );
    const outcome = await this.llm.generateStructured({
      tenant_id: input.tenant_id,
      model: SCREENING_AI_MODEL,
      system: FOLLOW_UP_SYSTEM,
      user_content: userContent,
      max_tokens: 600,
      json_schema: FOLLOW_UP_SCHEMA,
      schema_name: 'screening_follow_up',
    });
    const ok = this.unwrap(outcome, input.requestId);
    const parsed = (ok.parsed ?? {}) as { suggestions?: unknown[] };
    const suggestions = (parsed.suggestions ?? [])
      .map((s) => cleanText(s, SCREENING_QUESTION_MAX))
      .filter((s): s is string => s !== null)
      .slice(0, FOLLOW_UP_MAX);
    const generation = await this.provenance(input.tenant_id, ok.transport, {
      kind: 'FOLLOW_UP',
      prompt_version: FOLLOW_UP_PROMPT_VERSION,
      input_sha256: sha256(userContent),
      used_talent_profile: false,
      used_requisition: false,
      used_transcript: input.trigger.kind === 'TRANSCRIPT_SEGMENTS',
    });
    const triggerRef =
      input.trigger.kind === 'NOTE' ? { note_id: input.trigger.note_id } : { segment_ids: input.trigger.segment_ids };
    return this.guarded(input.requestId, () =>
      this.repo.saveSuggestions({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        actor_id: input.actor_id,
        generation,
        trigger_kind: input.trigger.kind,
        trigger_ref: triggerRef,
        suggestions,
      }),
    );
  }

  // ---- internals ------------------------------------------------------

  async assertAiProcessing(tenantId: string, talentRecordId: string, requestId: string): Promise<void> {
    const allowed = await this.consent.isAiProcessingAllowed(tenantId, talentRecordId);
    if (!allowed) {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'AI processing is not authorized for this talent (ai_processing consent is required)',
        403,
        { requestId, details: { reason: 'ai_processing_not_authorized' } },
      );
    }
  }

  private unwrap(
    outcome: StructuredGenerationOutcome,
    requestId: string,
  ): Extract<StructuredGenerationOutcome, { kind: 'ok' }> {
    if (outcome.kind === 'ok') return outcome;
    if (outcome.category === 'not_configured') {
      throw new AramoError(
        'LLM_PROVIDER_NOT_CONFIGURED',
        'no AI provider key is configured for this tenant',
        422,
        { requestId },
      );
    }
    throw new AramoError('SCREENING_AI_UNAVAILABLE', 'AI assistance is temporarily unavailable; try again', 503, {
      requestId,
      details: { category: outcome.category, retryable: outcome.kind === 'retryable' },
    });
  }

  // Honest provenance: the provider the tenant's call actually resolved to and
  // the model the provider reported using (never the requested default).
  async provenance(
    tenantId: string,
    transport: { model_used: string; provider_request_id?: string },
    rest: Omit<AiGenerationInput, 'provider' | 'model' | 'provider_request_id'>,
  ): Promise<AiGenerationInput> {
    const provider = this.providers !== undefined ? await this.providers.resolveActiveProvider(tenantId) : 'anthropic';
    return {
      ...rest,
      provider,
      model: transport.model_used,
      provider_request_id: transport.provider_request_id ?? null,
    };
  }

  private async guarded<T>(requestId: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (!(err instanceof ScreeningGuardError)) throw err;
      if (err.reason === 'not_found') throw new AramoError('NOT_FOUND', 'not found', 404, { requestId });
      if (err.reason === 'state_invalid') {
        throw new AramoError('SCREENING_SESSION_STATE_INVALID', 'the screening session is no longer a draft', 422, {
          requestId,
        });
      }
      throw err;
    }
  }
}
