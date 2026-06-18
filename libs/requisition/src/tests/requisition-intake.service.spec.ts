import { AramoError } from '@aramo/common';
import type { AiDraftService } from '@aramo/ai-draft';
import { describe, expect, it, vi } from 'vitest';

import { RequisitionIntakeService } from '../lib/requisition-intake.service.js';
import { INTAKE_TEXT_MAX_CHARS } from '../lib/intake-prompt.js';

// New Requisition AI intake service (charter §7.3, Lead ruling Tab 1).
// The PRE-CREATION generation path: intake text → extracted fields + JD +
// must/nice requirement skills. Mutates nothing (the AI never saves).

function fakeAiDraft(impl: AiDraftService['generateDraft']): AiDraftService {
  return { generateDraft: impl } as unknown as AiDraftService;
}

const TENANT = '00000000-0000-7000-8000-0000000000aa';

describe('RequisitionIntakeService.draftFromIntake', () => {
  it('rejects empty intake_text with VALIDATION_ERROR (400)', async () => {
    const svc = new RequisitionIntakeService(
      fakeAiDraft(vi.fn() as unknown as AiDraftService['generateDraft']),
    );
    await expect(
      svc.draftFromIntake({ tenant_id: TENANT, intake_text: '   ', requestId: 'r1' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  it('rejects over-length intake_text (no LLM call)', async () => {
    const gen = vi.fn();
    const svc = new RequisitionIntakeService(
      fakeAiDraft(gen as unknown as AiDraftService['generateDraft']),
    );
    await expect(
      svc.draftFromIntake({
        tenant_id: TENANT,
        intake_text: 'x'.repeat(INTAKE_TEXT_MAX_CHARS + 1),
        requestId: 'r1',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(gen).not.toHaveBeenCalled();
  });

  it('returns extracted fields + skills + the audit id on success', async () => {
    const gen = vi.fn().mockResolvedValue({
      completion: JSON.stringify({
        fields: { title: 'Senior Backend Engineer', rate_type: 'C2C' },
        jd_text: 'Build services.',
        required_skills: [{ name: 'Go' }],
        nice_to_have_skills: [{ name: 'gRPC' }],
      }),
      model_used: 'claude-sonnet-4-6',
      input_tokens: 100,
      output_tokens: 200,
      duration_ms: 1234,
      audit_record_id: '00000000-0000-7000-8000-0000000000cc',
    });
    const svc = new RequisitionIntakeService(
      fakeAiDraft(gen as unknown as AiDraftService['generateDraft']),
    );
    const out = await svc.draftFromIntake({
      tenant_id: TENANT,
      intake_text: 'Senior backend engineer, Go, C2C, Austin.',
      requestId: 'r1',
    });
    expect(out.fields.title).toBe('Senior Backend Engineer');
    expect(out.fields.rate_type).toBe('C2C');
    expect(out.required_skills).toEqual([{ name: 'Go' }]);
    expect(out.nice_to_have_skills).toEqual([{ name: 'gRPC' }]);
    expect(out.ai_draft_audit_record_id).toBe('00000000-0000-7000-8000-0000000000cc');
    // The prompt was built from the intake text (a single user prompt).
    expect(gen).toHaveBeenCalledTimes(1);
    const arg = gen.mock.calls[0][0] as { prompt: string };
    expect(arg.prompt).toContain('Senior backend engineer');
  });

  it('remaps a provider outage to AI_PROVIDER_UNAVAILABLE — never fabricates a draft', async () => {
    const gen = vi.fn().mockRejectedValue(
      new AramoError('INTERNAL_ERROR', 'provider down', 502, {
        requestId: 'r1',
        details: { kind: 'provider_unavailable' },
      }),
    );
    const svc = new RequisitionIntakeService(
      fakeAiDraft(gen as unknown as AiDraftService['generateDraft']),
    );
    await expect(
      svc.draftFromIntake({
        tenant_id: TENANT,
        intake_text: 'Senior backend engineer.',
        requestId: 'r1',
      }),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE', statusCode: 502 });
  });

  it('remaps a missing-key (secret-cache) failure to AI_PROVIDER_UNAVAILABLE', async () => {
    // The out-of-band key (AWS Secrets Manager) not being resolvable surfaces
    // as an INTERNAL_ERROR from the secret cache — it still means the AI lane
    // is unavailable, so the recruiter gets the honest "use manual" state.
    const gen = vi.fn().mockRejectedValue(
      new AramoError('INTERNAL_ERROR', 'secret missing', 500, {
        requestId: 'r1',
        details: { kind: 'secret_not_found' },
      }),
    );
    const svc = new RequisitionIntakeService(
      fakeAiDraft(gen as unknown as AiDraftService['generateDraft']),
    );
    await expect(
      svc.draftFromIntake({ tenant_id: TENANT, intake_text: 'x', requestId: 'r1' }),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE', statusCode: 502 });
  });

  it('remaps a provider rate-limit to AI_RATE_LIMITED (429)', async () => {
    const gen = vi.fn().mockRejectedValue(
      new AramoError('INTERNAL_ERROR', 'slow down', 429, {
        requestId: 'r1',
        details: { kind: 'provider_rate_limited' },
      }),
    );
    const svc = new RequisitionIntakeService(
      fakeAiDraft(gen as unknown as AiDraftService['generateDraft']),
    );
    await expect(
      svc.draftFromIntake({ tenant_id: TENANT, intake_text: 'x', requestId: 'r1' }),
    ).rejects.toMatchObject({ code: 'AI_RATE_LIMITED', statusCode: 429 });
  });

  it('passes a provider input-shape VALIDATION_ERROR through unchanged', async () => {
    const gen = vi.fn().mockRejectedValue(
      new AramoError('VALIDATION_ERROR', 'bad shape', 400, {
        requestId: 'r1',
        details: { kind: 'provider_input_invalid' },
      }),
    );
    const svc = new RequisitionIntakeService(
      fakeAiDraft(gen as unknown as AiDraftService['generateDraft']),
    );
    await expect(
      svc.draftFromIntake({ tenant_id: TENANT, intake_text: 'x', requestId: 'r1' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });
});
