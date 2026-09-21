import { describe, expect, it, vi } from 'vitest';

// TENANT-LLM-2 — OpenAI structured-generation adapter. Maps to the SAME neutral
// StructuredGenerationOutcome as the Anthropic adapter (grounding parity); NO raw
// provider text/reasoning crosses. SDK mocked at module level.
let createImpl: (args: Record<string, unknown>) => Promise<unknown> = async () => ({});

class MockErr extends Error {}
class MockAPIError extends MockErr {
  status?: number;
}
class MockRateLimitError extends MockErr {}
class MockAuthenticationError extends MockErr {}
class MockPermissionDeniedError extends MockErr {}
class MockBadRequestError extends MockErr {}
class MockUnprocessableEntityError extends MockErr {}
class MockInternalServerError extends MockErr {}
class MockAPIConnectionError extends MockErr {}
class MockAPIConnectionTimeoutError extends MockErr {}

vi.mock('openai', () => {
  class MockOpenAI {
    chat = { completions: { create: (args: Record<string, unknown>) => createImpl(args) } };
  }
  return {
    default: MockOpenAI,
    APIError: MockAPIError,
    RateLimitError: MockRateLimitError,
    AuthenticationError: MockAuthenticationError,
    PermissionDeniedError: MockPermissionDeniedError,
    BadRequestError: MockBadRequestError,
    UnprocessableEntityError: MockUnprocessableEntityError,
    InternalServerError: MockInternalServerError,
    APIConnectionError: MockAPIConnectionError,
    APIConnectionTimeoutError: MockAPIConnectionTimeoutError,
  };
});

const { OpenAiStructuredGenerationService } = await import(
  '../lib/structured-generation/openai-structured-generation.service.js'
);
const { SecretCacheService } = await import('../lib/secrets/secret-cache.service.js');
const { LlmKeyNotConfiguredError } = await import('../lib/secrets/llm-key-not-configured.error.js');

const TENANT = '11111111-1111-7111-8111-111111111111';

function makeService(key: string | Error = 'sk-openai') {
  const sc = new SecretCacheService();
  if (key instanceof Error) vi.spyOn(sc, 'getProviderApiKey').mockRejectedValue(key);
  else vi.spyOn(sc, 'getProviderApiKey').mockResolvedValue(key);
  return new OpenAiStructuredGenerationService(sc);
}
const REQ = {
  tenant_id: TENANT,
  model: 'gpt-4o',
  system: 'sys',
  user_content: 'u',
  max_tokens: 100,
  json_schema: { type: 'object', properties: { a: { type: 'string' } } },
  schema_name: 'demo/v1',
} as const;
const usage = { prompt_tokens: 5, completion_tokens: 7 };

describe('OpenAiStructuredGenerationService (TENANT-LLM-2)', () => {
  it('providerKey is openai', () => {
    expect(makeService().providerKey()).toBe('openai');
  });

  it('STRICT: parses content JSON → ok with safe transport (no raw text)', async () => {
    createImpl = async () => ({
      id: 'c1',
      model: 'gpt-4o',
      choices: [{ message: { content: '{"a":"x"}' }, finish_reason: 'stop' }],
      usage,
    });
    const out = await makeService().generateStructured(REQ);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.parsed).toEqual({ a: 'x' });
      expect(out.transport.model_used).toBe('gpt-4o');
      expect(out.transport.input_tokens).toBe(5);
      expect(out.transport.output_tokens).toBe(7);
    }
  });

  it('FORCED_TOOL: parses tool_call arguments → ok', async () => {
    createImpl = async () => ({
      id: 'c2',
      model: 'gpt-4o',
      choices: [
        {
          message: { tool_calls: [{ function: { name: 'demo_v1', arguments: '{"a":"y"}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
      usage,
    });
    const out = await makeService().generateStructured({ ...REQ, transport: 'FORCED_TOOL' });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.parsed).toEqual({ a: 'y' });
  });

  it('not-configured key → terminal not_configured (fail-closed, no fallback)', async () => {
    const out = await makeService(new LlmKeyNotConfiguredError(TENANT)).generateStructured(REQ);
    expect(out).toEqual({ kind: 'terminal', category: 'not_configured' });
  });

  it('finish_reason=length → retryable truncated', async () => {
    createImpl = async () => ({
      id: 'c3',
      model: 'gpt-4o',
      choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }],
      usage,
    });
    const out = await makeService().generateStructured(REQ);
    expect(out).toEqual({ kind: 'retryable', category: 'truncated' });
  });

  it('refusal → terminal empty_output (never surfaced as content)', async () => {
    createImpl = async () => ({
      id: 'c4',
      model: 'gpt-4o',
      choices: [{ message: { refusal: 'I cannot help with that', content: null }, finish_reason: 'stop' }],
      usage,
    });
    const out = await makeService().generateStructured(REQ);
    expect(out).toEqual({ kind: 'terminal', category: 'empty_output' });
  });

  it('maps RateLimitError → retryable rate_limited; AuthenticationError → terminal auth_config', async () => {
    createImpl = async () => {
      throw new MockRateLimitError('r');
    };
    expect(await makeService().generateStructured(REQ)).toEqual({ kind: 'retryable', category: 'rate_limited' });

    createImpl = async () => {
      throw new MockAuthenticationError('a');
    };
    expect(await makeService().generateStructured(REQ)).toEqual({ kind: 'terminal', category: 'auth_config' });
  });

  it('never surfaces raw provider text on error (safe category only)', async () => {
    createImpl = async () => {
      throw new MockBadRequestError('SECRET UPSTREAM DETAIL should not leak');
    };
    const out = await makeService().generateStructured(REQ);
    expect(out).toEqual({ kind: 'terminal', category: 'invalid_request' });
    expect(JSON.stringify(out)).not.toContain('SECRET UPSTREAM DETAIL');
  });
});
