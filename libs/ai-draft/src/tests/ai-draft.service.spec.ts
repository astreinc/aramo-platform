import { describe, expect, it, vi } from 'vitest';
import { AramoError, makeMockLogger } from '@aramo/common';

import { AiDraftService } from '../lib/ai-draft.service.js';
import type { AiDraftRepository } from '../lib/ai-draft.repository.js';
import type { DraftProvider } from '../lib/providers/draft-provider.interface.js';
import type { SecretCacheService } from '../lib/secrets/secret-cache.service.js';

// M5 PR-5 §4.15 — AiDraftService unit spec. All four collaborators
// (provider, secret cache, repository, logger) are mocked. The spec
// validates the 10-step orchestration contract.

const TENANT = '11111111-1111-7111-8111-111111111111';

function mocks(): {
  repo: AiDraftRepository;
  provider: DraftProvider;
  secretCache: SecretCacheService;
  appendEvent: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
} {
  const appendEvent = vi.fn(async (input: unknown) => input as never);
  const repo = { appendEvent } as unknown as AiDraftRepository;
  const generate = vi.fn().mockResolvedValue({
    completion: 'hello world',
    model_used: 'claude-sonnet-4-6',
    input_tokens: 5,
    output_tokens: 3,
    provider_request_id: 'msg_01',
  });
  const provider: DraftProvider = { generate };
  const secretCache = {} as SecretCacheService;
  return { repo, provider, secretCache, appendEvent, generate };
}

describe('AiDraftService.generateDraft', () => {
  it('happy path emits request_built + request_sent + response_received (3 events)', async () => {
    const { repo, provider, secretCache, appendEvent, generate } = mocks();
    const svc = new AiDraftService(provider, secretCache, repo, makeMockLogger());

    const result = await svc.generateDraft({
      tenant_id: TENANT,
      prompt: 'write a draft',
      max_tokens: 100,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.completion).toBe('hello world');
    expect(result.model_used).toBe('claude-sonnet-4-6');
    expect(result.audit_record_id).toMatch(/^[0-9a-f-]{36}$/i);

    const events = appendEvent.mock.calls.map((c) => (c[0] as { event_type: string }).event_type);
    expect(events).toEqual(['request_built', 'request_sent', 'response_received']);
  });

  it('emits redaction_applied (pre_prompt) when input contains PII', async () => {
    const { repo, provider, secretCache, appendEvent } = mocks();
    const svc = new AiDraftService(provider, secretCache, repo, makeMockLogger());

    await svc.generateDraft({
      tenant_id: TENANT,
      prompt: 'My SSN is 123-45-6789',
      max_tokens: 100,
    });

    const events = appendEvent.mock.calls.map((c) => (c[0] as { event_type: string }).event_type);
    expect(events).toContain('redaction_applied');
    const redaction = appendEvent.mock.calls.find(
      (c) => (c[0] as { event_type: string }).event_type === 'redaction_applied',
    );
    expect((redaction?.[0] as { event_payload: { kind: string } }).event_payload.kind).toBe(
      'pre_prompt',
    );
  });

  it('emits redaction_applied (post_completion) when output contains PII', async () => {
    const { repo, secretCache, appendEvent } = mocks();
    const provider: DraftProvider = {
      generate: vi.fn().mockResolvedValue({
        completion: 'leak: user@example.com',
        model_used: 'claude-sonnet-4-6',
        input_tokens: 5,
        output_tokens: 3,
        provider_request_id: 'msg_02',
      }),
    };
    const svc = new AiDraftService(provider, secretCache, repo, makeMockLogger());

    const result = await svc.generateDraft({
      tenant_id: TENANT,
      prompt: 'clean prompt',
      max_tokens: 100,
    });

    expect(result.completion).toBe('leak: [REDACTED:EMAIL]');
    const events = appendEvent.mock.calls.map((c) => (c[0] as { event_type: string }).event_type);
    const post = events.findIndex((e) => e === 'redaction_applied');
    expect(post).toBeGreaterThan(0);
  });

  it('rejects non-UUID tenant_id with VALIDATION_ERROR (no events emitted)', async () => {
    const { repo, provider, secretCache, appendEvent } = mocks();
    const svc = new AiDraftService(provider, secretCache, repo, makeMockLogger());
    await expect(
      svc.generateDraft({ tenant_id: 'not-a-uuid', prompt: 'hi', max_tokens: 1 }),
    ).rejects.toBeInstanceOf(AramoError);
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it('rejects empty prompt with VALIDATION_ERROR', async () => {
    const { repo, provider, secretCache } = mocks();
    const svc = new AiDraftService(provider, secretCache, repo, makeMockLogger());
    await expect(
      svc.generateDraft({ tenant_id: TENANT, prompt: '', max_tokens: 1 }),
    ).rejects.toBeInstanceOf(AramoError);
  });

  it('rejects max_tokens <= 0 with VALIDATION_ERROR', async () => {
    const { repo, provider, secretCache } = mocks();
    const svc = new AiDraftService(provider, secretCache, repo, makeMockLogger());
    await expect(
      svc.generateDraft({ tenant_id: TENANT, prompt: 'p', max_tokens: 0 }),
    ).rejects.toBeInstanceOf(AramoError);
  });

  it('emits error_raised when provider.generate throws', async () => {
    const { repo, secretCache, appendEvent } = mocks();
    const provider: DraftProvider = {
      generate: vi.fn().mockRejectedValue(
        new AramoError('INTERNAL_ERROR', 'provider down', 502, {
          requestId: 'ai-draft-provider',
          details: { kind: 'provider_unavailable' },
        }),
      ),
    };
    const svc = new AiDraftService(provider, secretCache, repo, makeMockLogger());

    await expect(
      svc.generateDraft({ tenant_id: TENANT, prompt: 'p', max_tokens: 1 }),
    ).rejects.toBeInstanceOf(AramoError);

    const events = appendEvent.mock.calls.map((c) => (c[0] as { event_type: string }).event_type);
    expect(events).toContain('error_raised');
  });

  it('propagates repository errors as AramoError', async () => {
    const { provider, secretCache } = mocks();
    const repo = {
      appendEvent: vi.fn().mockRejectedValue(new Error('db unreachable')),
    } as unknown as AiDraftRepository;
    const svc = new AiDraftService(provider, secretCache, repo, makeMockLogger());

    await expect(
      svc.generateDraft({ tenant_id: TENANT, prompt: 'p', max_tokens: 1 }),
    ).rejects.toBeInstanceOf(AramoError);
  });

  it('hashes redacted prompt (not raw) in request_built payload', async () => {
    const { repo, provider, secretCache, appendEvent } = mocks();
    const svc = new AiDraftService(provider, secretCache, repo, makeMockLogger());
    await svc.generateDraft({
      tenant_id: TENANT,
      prompt: 'SSN 123-45-6789 inside',
      max_tokens: 100,
    });
    const requestBuilt = appendEvent.mock.calls.find(
      (c) => (c[0] as { event_type: string }).event_type === 'request_built',
    );
    const payload = (requestBuilt?.[0] as { event_payload: { prompt_sha256: string; redacted_span_count_input: number } }).event_payload;
    expect(payload.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.redacted_span_count_input).toBe(1);
  });

  it('passes ARAMO_AI_DRAFT_MODEL when model is unspecified', async () => {
    const { repo, provider, secretCache, generate } = mocks();
    const svc = new AiDraftService(provider, secretCache, repo, makeMockLogger());
    await svc.generateDraft({
      tenant_id: TENANT,
      prompt: 'p',
      max_tokens: 1,
    });
    expect(generate.mock.calls[0]?.[0].model).toBe('claude-sonnet-4-6');
  });
});
