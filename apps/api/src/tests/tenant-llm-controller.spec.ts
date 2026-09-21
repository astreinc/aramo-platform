import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import { TenantLlmController } from '../tenant-llm/tenant-llm.controller.js';

// TENANT-LLM-2 §7 — no-dead-knobs proof at the controller boundary: an unwired
// provider path segment is rejected with VALIDATION_ERROR (allowed-set surfaced)
// BEFORE it can reach a missing adapter. tenant_id/actor always from AuthContext.

const AUTH = { tenant_id: '11111111-1111-7111-8111-111111111111', sub: 'actor-1' } as never;

function make() {
  const service = {
    setKey: vi.fn().mockResolvedValue(undefined),
    clearKey: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ provider: 'anthropic', configured: false }),
    setActiveProvider: vi.fn().mockResolvedValue(undefined),
    overview: vi.fn().mockResolvedValue({ active_provider: 'anthropic', providers: [] }),
  };
  return { controller: new TenantLlmController(service as never), service };
}

describe('TenantLlmController — no-dead-knobs (wired-set validation)', () => {
  it('rejects an unwired provider on status with VALIDATION_ERROR + allowed set', async () => {
    const { controller, service } = make();
    try {
      await controller.status(AUTH, 'gemini', 'rq');
      expect.fail('expected VALIDATION_ERROR');
    } catch (e) {
      expect(e).toBeInstanceOf(AramoError);
      expect((e as AramoError).context.details?.['reason']).toBe('provider_not_wired');
      expect((e as AramoError).context.details?.['allowed']).toEqual(['anthropic', 'openai']);
    }
    expect(service.status).not.toHaveBeenCalled(); // never reached the service
  });

  it('rejects an unwired provider on setKey (before any write)', async () => {
    const { controller, service } = make();
    await expect(controller.setKey(AUTH, 'bedrock', { api_key: 'x' }, 'rq')).rejects.toBeInstanceOf(AramoError);
    expect(service.setKey).not.toHaveBeenCalled();
  });

  it('rejects an unwired active-provider selection', async () => {
    const { controller, service } = make();
    await expect(controller.selectActiveProvider(AUTH, { provider: 'azure' }, 'rq')).rejects.toBeInstanceOf(AramoError);
    expect(service.setActiveProvider).not.toHaveBeenCalled();
  });

  it('accepts a wired provider (openai) and delegates to the service', async () => {
    const { controller, service } = make();
    await controller.status(AUTH, 'openai', 'rq');
    expect(service.status).toHaveBeenCalledWith(AUTH.tenant_id, 'openai');
  });

  it('setKey rejects a missing api_key even for a wired provider', async () => {
    const { controller, service } = make();
    await expect(controller.setKey(AUTH, 'anthropic', {}, 'rq')).rejects.toBeInstanceOf(AramoError);
    expect(service.setKey).not.toHaveBeenCalled();
  });
});
