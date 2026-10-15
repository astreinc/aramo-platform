import { describe, expect, it } from 'vitest';
import type {
  StructuredGenerationOutcome,
  StructuredGenerationProvider,
  StructuredGenerationRequest,
} from '@aramo/ai-draft';

import { ScreeningAiService } from '../lib/ai/screening-ai.service.js';
import type { TechnicalScreeningRepository } from '../lib/technical-screening.repository.js';

// TIP-E2E INC-3 A1-3 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED §B.3, §B.4, Part G, R-A)
// — the screening AI service in isolation: fail-closed ai_processing before any
// Talent content reaches a model, requisition-only generation without Talent
// consent, pre-send redaction, honest provider/model provenance, and governed
// error mapping (LLM_PROVIDER_NOT_CONFIGURED / SCREENING_AI_UNAVAILABLE).

class FakeLlm implements StructuredGenerationProvider {
  requests: StructuredGenerationRequest[] = [];
  constructor(private readonly outcome: StructuredGenerationOutcome) {}
  providerKey(): string {
    return 'anthropic';
  }
  async generateStructured(request: StructuredGenerationRequest): Promise<StructuredGenerationOutcome> {
    this.requests.push(request);
    return this.outcome;
  }
}

function fakeRepo() {
  const saved: { plans: unknown[]; suggestions: unknown[] } = { plans: [], suggestions: [] };
  const repo = {
    saveQuestionPlan: async (input: unknown) => {
      saved.plans.push(input);
      return { generation_id: 'g1', questions: [] };
    },
    saveSuggestions: async (input: unknown) => {
      saved.suggestions.push(input);
      return [];
    },
  } as unknown as TechnicalScreeningRepository;
  return { repo, saved };
}

const OK: StructuredGenerationOutcome = {
  kind: 'ok',
  parsed: {
    questions: [
      { text: 'Walk me through how you would roll back a failed deployment.', skill_ref: 'Kubernetes' },
      { text: '   ', skill_ref: null },
    ],
  },
  transport: { model_used: 'gpt-4o', input_tokens: 10, output_tokens: 20, provider_request_id: 'req_9' },
};

const REQ = {
  title: 'Platform Engineer',
  required_skills: ['Kubernetes'],
  preferred_skills: ['Go'],
  job_description: 'Run clusters. Contact hiring@acme.example for details.',
  experience_summary: '5 years',
};
const TALENT = {
  headline: null,
  skills: ['Kubernetes', 'Go'],
  work_history: [{ title: 'SRE', organization: 'Acme', summary: 'Reach me at dev@person.example or 555-123-4567' }],
  resume_excerpt: 'SSN 123-45-6789 should never be sent',
};

const base = {
  tenant_id: 't1',
  session_id: 's1',
  talent_record_id: 'r1',
  actor_id: 'u1',
  requestId: 'rq',
};

const providers = { resolveActiveProvider: async () => 'openai' as const };

describe('ScreeningAiService — question plan (G-1/G-2, R-A)', () => {
  it('fails closed with 403 and makes NO model call when Talent content is sent without ai_processing', async () => {
    const llm = new FakeLlm(OK);
    const { repo } = fakeRepo();
    const svc = new ScreeningAiService(repo, llm, { isAiProcessingAllowed: async () => false }, providers);
    await expect(
      svc.generateQuestionPlan({ ...base, requisition: REQ, talent: TALENT }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(llm.requests).toHaveLength(0);
  });

  it('requisition-only generation needs no Talent consent and records used_talent_profile=false', async () => {
    const llm = new FakeLlm(OK);
    const { repo, saved } = fakeRepo();
    const svc = new ScreeningAiService(repo, llm, { isAiProcessingAllowed: async () => false }, providers);
    await svc.generateQuestionPlan({ ...base, requisition: REQ, talent: null });
    expect(llm.requests).toHaveLength(1);
    const plan = saved.plans[0] as { generation: Record<string, unknown>; questions: unknown[] };
    expect(plan.generation).toMatchObject({ used_talent_profile: false, used_requisition: true, used_transcript: false });
    expect(plan.questions).toEqual([
      { text: 'Walk me through how you would roll back a failed deployment.', skill_ref: 'Kubernetes', intent: 'PROBE' },
    ]);
  });

  it('redacts every field before sending and records the provider + model ACTUALLY used', async () => {
    const llm = new FakeLlm(OK);
    const { repo, saved } = fakeRepo();
    const svc = new ScreeningAiService(repo, llm, { isAiProcessingAllowed: async () => true }, providers);
    await svc.generateQuestionPlan({ ...base, requisition: REQ, talent: TALENT });
    const sent = llm.requests[0]!.user_content;
    for (const pii of ['hiring@acme.example', 'dev@person.example', '555-123-4567', '123-45-6789']) {
      expect(sent).not.toContain(pii);
    }
    expect(llm.requests[0]!.schema_name).toBe('screening_question_plan');
    const plan = saved.plans[0] as { generation: Record<string, unknown> };
    expect(plan.generation).toMatchObject({
      kind: 'QUESTION_PLAN',
      provider: 'openai',
      model: 'gpt-4o',
      provider_request_id: 'req_9',
      used_talent_profile: true,
      prompt_version: 'inc3-a1.question-plan.v1',
    });
    expect(String(plan.generation['input_sha256'])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('maps a missing tenant key to 422 LLM_PROVIDER_NOT_CONFIGURED and other failures to 503 SCREENING_AI_UNAVAILABLE', async () => {
    const { repo } = fakeRepo();
    const notConfigured = new ScreeningAiService(repo, new FakeLlm({ kind: 'terminal', category: 'not_configured' }), { isAiProcessingAllowed: async () => true }, providers);
    await expect(notConfigured.generateQuestionPlan({ ...base, requisition: REQ, talent: null })).rejects.toMatchObject({
      code: 'LLM_PROVIDER_NOT_CONFIGURED',
      statusCode: 422,
    });
    const flaky = new ScreeningAiService(repo, new FakeLlm({ kind: 'retryable', category: 'rate_limited' }), { isAiProcessingAllowed: async () => true }, providers);
    await expect(flaky.generateQuestionPlan({ ...base, requisition: REQ, talent: null })).rejects.toMatchObject({
      code: 'SCREENING_AI_UNAVAILABLE',
      statusCode: 503,
    });
    const empty = new ScreeningAiService(repo, new FakeLlm({ ...OK, parsed: { questions: [] } } as StructuredGenerationOutcome), { isAiProcessingAllowed: async () => true }, providers);
    await expect(empty.generateQuestionPlan({ ...base, requisition: REQ, talent: null })).rejects.toMatchObject({
      code: 'SCREENING_AI_UNAVAILABLE',
    });
  });

  it('refuses generation with neither requisition nor talent context (400)', async () => {
    const { repo } = fakeRepo();
    const svc = new ScreeningAiService(repo, new FakeLlm(OK), { isAiProcessingAllowed: async () => true }, providers);
    await expect(svc.generateQuestionPlan({ ...base, requisition: null, talent: null })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('ScreeningAiService — follow-up suggestions (G-4)', () => {
  it('is always ai_processing-gated (recruiter notes are about the talent)', async () => {
    const llm = new FakeLlm(OK);
    const { repo } = fakeRepo();
    const svc = new ScreeningAiService(repo, llm, { isAiProcessingAllowed: async () => false }, providers);
    await expect(
      svc.suggestFollowUps({ ...base, trigger: { kind: 'NOTE', note_id: 'n1', text: 'vague on storage' }, plan: [] }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(llm.requests).toHaveLength(0);
  });

  it('records suggestions with NOTE trigger provenance and at most three items', async () => {
    const llm = new FakeLlm({
      kind: 'ok',
      parsed: { suggestions: ['Which storage class?', 'How were volumes backed up?', 'What failed?', 'extra'] },
      transport: { model_used: 'claude-sonnet-4-6', input_tokens: 1, output_tokens: 1 },
    });
    const { repo, saved } = fakeRepo();
    const svc = new ScreeningAiService(repo, llm, { isAiProcessingAllowed: async () => true }, undefined);
    await svc.suggestFollowUps({ ...base, trigger: { kind: 'NOTE', note_id: 'n1', text: 'vague on storage' }, plan: ['Q1'] });
    const s = saved.suggestions[0] as Record<string, unknown>;
    expect(s['trigger_kind']).toBe('NOTE');
    expect(s['trigger_ref']).toEqual({ note_id: 'n1' });
    expect((s['suggestions'] as unknown[]).length).toBe(3);
    expect(s['generation']).toMatchObject({ kind: 'FOLLOW_UP', provider: 'anthropic', model: 'claude-sonnet-4-6', used_transcript: false });
  });
});
