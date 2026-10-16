import { describe, expect, it } from 'vitest';

import {
  PROVIDER_DEFAULT_MODEL,
  PROVIDER_MODEL_ALLOWLIST,
  resolveProviderModel,
} from '../lib/providers/llm-provider.js';

describe('per-provider model allowlist (TENANT-LLM-2 §2.5)', () => {
  it('OpenAI defaults to gpt-4.1; gpt-4o and gpt-4o-mini stay allowlisted', () => {
    expect(PROVIDER_DEFAULT_MODEL.openai).toBe('gpt-4.1');
    expect(PROVIDER_MODEL_ALLOWLIST.openai).toEqual(['gpt-4.1', 'gpt-4o', 'gpt-4o-mini']);
  });

  it('a caller asking for the Anthropic constant on an OpenAI tenant gets gpt-4.1 (never cross-provider)', () => {
    expect(resolveProviderModel('openai', 'claude-sonnet-4-6')).toBe('gpt-4.1');
    expect(resolveProviderModel('openai', 'gpt-4o')).toBe('gpt-4o');
    expect(resolveProviderModel('anthropic', 'gpt-4.1')).toBe('claude-sonnet-4-6');
  });

  it('no reasoning-class model is allowlisted (they need max_completion_tokens)', () => {
    for (const m of PROVIDER_MODEL_ALLOWLIST.openai) expect(m).not.toMatch(/^(o\d|gpt-5)/);
  });
});
