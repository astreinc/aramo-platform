import { beforeEach, describe, expect, it, vi } from 'vitest';

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

type SecretCacheLike = { getAnthropicApiKey: () => Promise<string> };
function service(secret: SecretCacheLike) {
  return new AnthropicStructuredGenerationService(secret as never);
}

const REQ = {
  model: 'claude-sonnet-4-6',
  system: 'SYSTEM',
  user_content: 'USER',
  max_tokens: 8192,
  json_schema: { type: 'object' },
  schema_name: 'x',
};
const okSecret: SecretCacheLike = { getAnthropicApiKey: async () => 'key-abc' };

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

  it('valid structured output → ok + parsed + transport; NON-STREAMING native output', async () => {
    const out = await service(okSecret).generateStructured(REQ);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.parsed).toEqual({ ok: true });
    expect(out.transport).toEqual({ model_used: 'claude-sonnet-4-6', input_tokens: 10, output_tokens: 20, provider_request_id: 'msg_1' });
    expect(lastArgs!['output_config']).toEqual({ format: { type: 'json_schema', schema: { type: 'object' } } });
    expect(lastArgs!['stream']).toBeUndefined();
    expect(lastArgs!['thinking']).toBeUndefined();
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

  it('truncation (stop_reason=max_tokens) → retryable malformed_output', async () => {
    createImpl = async () => message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":' }] });
    expect(await service(okSecret).generateStructured(REQ)).toEqual({ kind: 'retryable', category: 'malformed_output' });
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
    const out = await service({ getAnthropicApiKey: async () => { throw new Error('sm down'); } }).generateStructured(REQ);
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
