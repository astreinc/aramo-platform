import { describe, expect, it, vi } from 'vitest';

import { ProviderDraftDispatcher } from '../lib/providers/provider-draft-dispatcher.js';
import { ProviderStructuredGenerationDispatcher } from '../lib/structured-generation/provider-structured-generation-dispatcher.js';
import type { ActiveProviderResolver } from '../lib/providers/active-provider-resolver.js';
import type { LlmProvider } from '../lib/providers/llm-provider.js';

// TENANT-LLM-2 — the tenant-aware dispatchers. Proves: per-tenant routing to the
// resolved provider ONLY (no cross-provider call), default 'anthropic' when the
// resolver is absent (pre-TENANT-LLM-2 behaviour), and provider-appropriate model
// pinning (never a cross-provider model id).

const TENANT = '11111111-1111-7111-8111-111111111111';

function draftAdapter(tag: string) {
  return {
    generate: vi.fn(async (input: { model: string }) => ({
      completion: tag,
      model_used: input.model,
      input_tokens: 0,
      output_tokens: 0,
      provider_request_id: tag,
    })),
  };
}
function structAdapter(tag: string) {
  return {
    providerKey: () => tag,
    generateStructured: vi.fn(async (req: { model: string }) => ({
      kind: 'ok' as const,
      parsed: { tag, model: req.model },
      transport: { model_used: req.model, input_tokens: 0, output_tokens: 0 },
    })),
  };
}
function resolverOf(p: LlmProvider): ActiveProviderResolver {
  return { resolveActiveProvider: vi.fn(async () => p) };
}

const draftInput = { tenant_id: TENANT, model: 'claude-sonnet-4-6', prompt: 'p', max_tokens: 1 };
const structReq = {
  tenant_id: TENANT,
  model: 'claude-sonnet-4-6',
  system: 's',
  user_content: 'u',
  max_tokens: 1,
  json_schema: {},
  schema_name: 'x',
} as const;

describe('ProviderDraftDispatcher (TENANT-LLM-2)', () => {
  it('routes to the OpenAI adapter when the tenant active provider is openai — anthropic NOT called', async () => {
    const anth = draftAdapter('anthropic');
    const oai = draftAdapter('openai');
    const resolver = resolverOf('openai');
    const d = new ProviderDraftDispatcher(
      anth as never,
      oai as never,
      resolver,
    );
    const res = await d.generate(draftInput);
    expect(res.completion).toBe('openai');
    expect(oai.generate).toHaveBeenCalledTimes(1);
    expect(anth.generate).not.toHaveBeenCalled();
    expect(resolver.resolveActiveProvider).toHaveBeenCalledWith(TENANT);
    // model pinned to the OpenAI default (the caller's Anthropic model is not
    // openai-allowlisted → never sent cross-provider).
    expect(oai.generate.mock.calls[0][0].model).toBe('gpt-4o');
  });

  it('routes to Anthropic when active provider is anthropic (caller model kept)', async () => {
    const anth = draftAdapter('anthropic');
    const oai = draftAdapter('openai');
    const d = new ProviderDraftDispatcher(
      anth as never,
      oai as never,
      resolverOf('anthropic'),
    );
    const res = await d.generate(draftInput);
    expect(res.completion).toBe('anthropic');
    expect(anth.generate.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
    expect(oai.generate).not.toHaveBeenCalled();
  });

  it('defaults to Anthropic when NO resolver is bound (pre-TENANT-LLM-2 behaviour)', async () => {
    const anth = draftAdapter('anthropic');
    const oai = draftAdapter('openai');
    const d = new ProviderDraftDispatcher(
      anth as never,
      oai as never,
      undefined,
    );
    const res = await d.generate(draftInput);
    expect(res.completion).toBe('anthropic');
    expect(oai.generate).not.toHaveBeenCalled();
  });
});

describe('ProviderStructuredGenerationDispatcher (TENANT-LLM-2)', () => {
  it('routes to the resolved provider (openai) — anthropic NOT called', async () => {
    const anth = structAdapter('anthropic');
    const oai = structAdapter('openai');
    const d = new ProviderStructuredGenerationDispatcher(anth as never, oai as never, resolverOf('openai'));
    const out = await d.generateStructured(structReq);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect((out.parsed as { tag: string }).tag).toBe('openai');
    expect(oai.generateStructured).toHaveBeenCalledTimes(1);
    expect(anth.generateStructured).not.toHaveBeenCalled();
    expect(oai.generateStructured.mock.calls[0][0].model).toBe('gpt-4o');
  });

  it('providerKey stays anthropic (stable registration/telemetry key)', () => {
    const d = new ProviderStructuredGenerationDispatcher(
      structAdapter('anthropic') as never,
      structAdapter('openai') as never,
      resolverOf('openai'),
    );
    expect(d.providerKey()).toBe('anthropic');
  });

  it('defaults to Anthropic when NO resolver is bound', async () => {
    const anth = structAdapter('anthropic');
    const oai = structAdapter('openai');
    const d = new ProviderStructuredGenerationDispatcher(anth as never, oai as never, undefined);
    const out = await d.generateStructured(structReq);
    if (out.kind === 'ok') expect((out.parsed as { tag: string }).tag).toBe('anthropic');
    expect(oai.generateStructured).not.toHaveBeenCalled();
  });
});
