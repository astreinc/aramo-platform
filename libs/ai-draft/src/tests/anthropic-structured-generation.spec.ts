import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LlmKeyNotConfiguredError } from '../lib/secrets/llm-key-not-configured.error.js';

// Mock the Anthropic SDK: a plain async `createImpl` holder (NOT a vi.fn — a
// vi.fn rejected-promise interacts badly with the service's try/await/catch in
// this runner) + minimal error classes (instanceof must work for mapError; the
// service and this test import the SAME mocked module, so it is consistent).
let createImpl: (args: Record<string, unknown>) => Promise<unknown> = async () => ({});
let lastArgs: Record<string, unknown> | null = null;

class MockAPIError extends Error {
  constructor(readonly status: number) {
    super('masked');
    this.name = 'APIError';
  }
}
class MockRateLimitError extends MockAPIError { constructor() { super(429); } }
class MockInternalServerError extends MockAPIError { constructor() { super(500); } }
class MockAuthenticationError extends MockAPIError { constructor() { super(401); } }
class MockPermissionDeniedError extends MockAPIError { constructor() { super(403); } }
class MockBadRequestError extends MockAPIError { constructor() { super(400); } }
class MockUnprocessableEntityError extends MockAPIError { constructor() { super(422); } }
class MockAPIConnectionError extends Error {}
class MockAPIConnectionTimeoutError extends Error {}

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      create: (args: Record<string, unknown>) => {
        lastArgs = args;
        return createImpl(args);
      },
    };
  }
  return {
    default: MockAnthropic,
    APIError: MockAPIError,
    RateLimitError: MockRateLimitError,
    InternalServerError: MockInternalServerError,
    AuthenticationError: MockAuthenticationError,
    PermissionDeniedError: MockPermissionDeniedError,
    BadRequestError: MockBadRequestError,
    UnprocessableEntityError: MockUnprocessableEntityError,
    APIConnectionError: MockAPIConnectionError,
    APIConnectionTimeoutError: MockAPIConnectionTimeoutError,
  };
});

const { AnthropicStructuredGenerationService } = await import(
  '../lib/structured-generation/anthropic-structured-generation.service.js'
);

type SecretCacheLike = { getProviderApiKey: () => Promise<string> };
function service(secret: SecretCacheLike) {
  return new AnthropicStructuredGenerationService(secret as never);
}

const REQ = {
  tenant_id: '11111111-1111-7111-8111-111111111111',
  model: 'claude-sonnet-4-6',
  system: 'SYSTEM',
  user_content: 'USER',
  max_tokens: 8192,
  json_schema: { type: 'object' },
  schema_name: 'x',
};
const okSecret: SecretCacheLike = { getProviderApiKey: async () => 'key-abc' };
// TENANT-LLM-1 — a tenant with no key configured.
const notConfiguredSecret: SecretCacheLike = {
  getProviderApiKey: async () => {
    throw new LlmKeyNotConfiguredError('11111111-1111-7111-8111-111111111111');
  },
};

function message(overrides: Record<string, unknown>) {
  return {
    id: 'msg_1',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20 },
    content: [{ type: 'text', text: '{"ok":true}' }],
    ...overrides,
  };
}

describe('AnthropicStructuredGenerationService', () => {
  beforeEach(() => {
    lastArgs = null;
    createImpl = async () => message({});
  });

  it('TENANT-LLM-1 — a not-configured tenant key → terminal not_configured (fail-closed, never retryable/fallback)', async () => {
    const out = await service(notConfiguredSecret).generateStructured(REQ);
    expect(out).toEqual({ kind: 'terminal', category: 'not_configured' });
  });

  it('valid structured output → ok + parsed + transport; NON-STREAMING native output', async () => {
    const out = await service(okSecret).generateStructured(REQ);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.parsed).toEqual({ ok: true });
    expect(out.transport).toEqual({ model_used: 'claude-sonnet-4-6', input_tokens: 10, output_tokens: 20, provider_request_id: 'msg_1' });
    expect(lastArgs!['output_config']).toEqual({ format: { type: 'json_schema', schema: { type: 'object' } } });
    expect(lastArgs!['stream']).toBeUndefined();
    expect(lastArgs!['thinking']).toBeUndefined();
    // DEFAULT transport is STRICT: no tool-use is ever used implicitly.
    expect(lastArgs!['tools']).toBeUndefined();
    expect(lastArgs!['tool_choice']).toBeUndefined();
  });

  it('explicit STRICT_JSON_SCHEMA behaves identically to the default (no tools)', async () => {
    const out = await service(okSecret).generateStructured({ ...REQ, transport: 'STRICT_JSON_SCHEMA' });
    expect(out.kind).toBe('ok');
    expect(lastArgs!['output_config']).toEqual({ format: { type: 'json_schema', schema: { type: 'object' } } });
    expect(lastArgs!['tools']).toBeUndefined();
  });

  it('FORCED_TOOL → one forced tool (input_schema = schema), consumes tool_use input, NO output_config', async () => {
    createImpl = async () => message({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'ignored free-form preamble' },
        { type: 'tool_use', id: 't1', name: 'resume-draft-extraction_v3', input: { skills: [], work_history: [{ employer_name: 'Acme' }] } },
      ],
    });
    const out = await service(okSecret).generateStructured({
      ...REQ,
      transport: 'FORCED_TOOL',
      schema_name: 'resume-draft-extraction/v3',
      json_schema: { type: 'object', properties: { skills: { type: 'array' } } },
    });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    // Only the forced tool's structured input is consumed (free-form text ignored).
    expect(out.parsed).toEqual({ skills: [], work_history: [{ employer_name: 'Acme' }] });
    // Transport is tools + forced tool_choice — NOT constrained-decoding output_config.
    expect(lastArgs!['output_config']).toBeUndefined();
    const tools = lastArgs!['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!['input_schema']).toEqual({ type: 'object', properties: { skills: { type: 'array' } } });
    // Tool name sanitized to Anthropic's ^[a-zA-Z0-9_-]{1,64}$ (no '/').
    expect(tools[0]!['name']).toBe('resume-draft-extraction_v3');
    expect(lastArgs!['tool_choice']).toEqual({ type: 'tool', name: 'resume-draft-extraction_v3' });
  });

  it('FORCED_TOOL with no tool_use block → terminal empty_output (never reads free-form text as extraction)', async () => {
    createImpl = async () => message({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"sneaky":true}' }] });
    const out = await service(okSecret).generateStructured({ ...REQ, transport: 'FORCED_TOOL' });
    expect(out).toEqual({ kind: 'terminal', category: 'empty_output' });
  });

  it('FORCED_TOOL truncation (stop_reason=max_tokens) → retryable truncated', async () => {
    createImpl = async () => message({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] });
    expect(await service(okSecret).generateStructured({ ...REQ, transport: 'FORCED_TOOL' })).toEqual({ kind: 'retryable', category: 'truncated' });
  });

  it('DISCARDS thinking blocks — only text is parsed (§10)', async () => {
    createImpl = async () => message({
      content: [
        { type: 'thinking', thinking: 'secret reasoning' },
        { type: 'redacted_thinking', data: 'xxx' },
        { type: 'text', text: '{"kept":1}' },
      ],
    });
    const out = await service(okSecret).generateStructured(REQ);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.parsed).toEqual({ kept: 1 });
  });

  it('truncation (stop_reason=max_tokens) → retryable truncated (HF1 §13/R9)', async () => {
    createImpl = async () => message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":' }] });
    expect(await service(okSecret).generateStructured(REQ)).toEqual({ kind: 'retryable', category: 'truncated' });
  });

  it('empty text → terminal empty_output', async () => {
    createImpl = async () => message({ content: [{ type: 'thinking', thinking: 'x' }] });
    expect(await service(okSecret).generateStructured(REQ)).toEqual({ kind: 'terminal', category: 'empty_output' });
  });

  it('unparseable text → retryable malformed_output', async () => {
    createImpl = async () => message({ content: [{ type: 'text', text: 'not json' }] });
    expect(await service(okSecret).generateStructured(REQ)).toEqual({ kind: 'retryable', category: 'malformed_output' });
  });

  it('secret resolution failure → retryable transport (no provider call)', async () => {
    let called = false;
    createImpl = async () => { called = true; return message({}); };
    const out = await service({ getProviderApiKey: async () => { throw new Error('sm down'); } }).generateStructured(REQ);
    expect(out).toEqual({ kind: 'retryable', category: 'transport' });
    expect(called).toBe(false);
  });

  it('maps provider errors to SAFE categories (no raw message text)', async () => {
    const cases: (() => [Error, { kind: string; category: string }])[] = [
      () => [new MockRateLimitError(), { kind: 'retryable', category: 'rate_limited' }],
      () => [new MockInternalServerError(), { kind: 'retryable', category: 'server_error' }],
      () => [new MockAPIConnectionTimeoutError(), { kind: 'retryable', category: 'timeout' }],
      () => [new MockAPIConnectionError(), { kind: 'retryable', category: 'network' }],
      () => [new MockAuthenticationError(), { kind: 'terminal', category: 'auth_config' }],
      () => [new MockPermissionDeniedError(), { kind: 'terminal', category: 'auth_config' }],
      () => [new MockBadRequestError(), { kind: 'terminal', category: 'invalid_request' }],
      () => [new MockUnprocessableEntityError(), { kind: 'terminal', category: 'invalid_request' }],
    ];
    for (const make of cases) {
      const [err, expected] = make();
      createImpl = async () => { throw err; };
      const out = await service(okSecret).generateStructured(REQ);
      expect(out).toEqual(expected);
      expect(JSON.stringify(out)).not.toContain('masked');
    }
  });

  it('unknown non-API error → retryable transport', async () => {
    createImpl = async () => { throw new Error('boom'); };
    expect(await service(okSecret).generateStructured(REQ)).toEqual({ kind: 'retryable', category: 'transport' });
  });
});
