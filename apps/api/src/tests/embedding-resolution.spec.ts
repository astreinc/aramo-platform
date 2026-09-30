import { describe, expect, it, vi } from 'vitest';
import type { TenantSettingService } from '@aramo/settings';

import { SettingsActiveEmbeddingProviderResolver } from '../embedding/settings-active-embedding-provider.resolver.js';

// GS-2 P2 — the app-side embedding-provider resolver reads ONLY `embedding.active_provider`, is
// independent of `llm.active_provider`, and surfaces the KnownSetting default via settings.get.

function make(getImpl: (tenantId: string, key: string) => Promise<unknown>) {
  const get = vi.fn(getImpl);
  const resolver = new SettingsActiveEmbeddingProviderResolver({ get } as unknown as TenantSettingService);
  return { resolver, get };
}

describe('SettingsActiveEmbeddingProviderResolver (GS-2 P2)', () => {
  it('reads embedding.active_provider (never llm.active_provider) and returns it', async () => {
    const { resolver, get } = make(async (_t, key) =>
      key === 'embedding.active_provider' ? 'openai' : 'anthropic',
    );
    expect(await resolver.resolveActiveEmbeddingProvider('t-1')).toBe('openai');
    expect(get).toHaveBeenCalledWith('t-1', 'embedding.active_provider');
    expect(get).not.toHaveBeenCalledWith('t-1', 'llm.active_provider');
  });

  it('is independent of the chat provider — reads only its own key', async () => {
    const { resolver, get } = make(async (_t, key) => {
      if (key === 'embedding.active_provider') return 'openai';
      throw new Error(`unexpected settings key: ${key}`);
    });
    expect(await resolver.resolveActiveEmbeddingProvider('t-9')).toBe('openai');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('surfaces the KnownSetting default (openai) for an unset tenant via settings.get', async () => {
    const { resolver } = make(async () => 'openai');
    expect(await resolver.resolveActiveEmbeddingProvider('t-unset')).toBe('openai');
  });
});
