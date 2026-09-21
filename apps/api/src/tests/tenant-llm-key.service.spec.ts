import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import { TenantLlmKeyService } from '../tenant-llm/tenant-llm-key.service.js';
import { TENANT_LLM_TOMBSTONE } from '../tenant-llm/tenant-llm-secret-ref.js';

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '22222222-2222-7222-8222-222222222222';
const ANTHROPIC_ID = `aramo/test/tenant-llm/${TENANT}/anthropic-api-key`;
const OPENAI_ID = `aramo/test/tenant-llm/${TENANT}/openai-api-key`;

function make(opts: { readValue?: string | Error; activeProvider?: string } = {}) {
  const put = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockImplementation(async () => {
    if (opts.readValue instanceof Error) throw opts.readValue;
    if (opts.readValue === undefined) throw new Error('ResourceNotFound');
    return opts.readValue;
  });
  const invalidate = vi.fn();
  const settingsGet = vi.fn().mockResolvedValue(opts.activeProvider ?? 'anthropic');
  const settingsSet = vi.fn().mockResolvedValue({ key: 'llm.active_provider', value: 'openai', previous_value: null });
  const log = vi.fn();
  const svc = new TenantLlmKeyService(
    { putSecretValue: put } as never,
    { getSecretValue: get } as never,
    { invalidate } as never,
    { get: settingsGet, set: settingsSet } as never,
    { log, warn: vi.fn(), error: vi.fn() } as never,
  );
  return { svc, put, get, invalidate, settingsGet, settingsSet, log };
}

describe('TenantLlmKeyService (TENANT-LLM-1/2 §P2)', () => {
  beforeEach(() => {
    process.env['ARAMO_ENV'] = 'test';
  });

  it('setKey writes to the per-PROVIDER secret id and invalidates that provider only', async () => {
    const { svc, put, invalidate } = make();
    await svc.setKey({ tenant_id: TENANT, actor_id: ACTOR, provider: 'anthropic', api_key: 'sk-ant', requestId: 'rq' });
    expect(put).toHaveBeenCalledWith(ANTHROPIC_ID, 'sk-ant');
    expect(invalidate).toHaveBeenCalledWith(TENANT, 'anthropic');

    const { svc: svc2, put: put2, invalidate: inv2 } = make();
    await svc2.setKey({ tenant_id: TENANT, actor_id: ACTOR, provider: 'openai', api_key: 'sk-oai', requestId: 'rq' });
    expect(put2).toHaveBeenCalledWith(OPENAI_ID, 'sk-oai'); // distinct provider id
    expect(inv2).toHaveBeenCalledWith(TENANT, 'openai');
  });

  it('setKey audits actor+tenant+provider but NEVER the key value or its length', async () => {
    const { svc, log } = make();
    await svc.setKey({ tenant_id: TENANT, actor_id: ACTOR, provider: 'openai', api_key: 'sk-super-secret', requestId: 'rq' });
    const evt = log.mock.calls[0][0];
    expect(evt).toMatchObject({ event: 'tenant_llm.key_set', tenant_id: TENANT, actor_id: ACTOR, provider: 'openai' });
    const serialized = JSON.stringify(evt);
    expect(serialized).not.toContain('sk-super-secret');
    expect(serialized).not.toContain('length');
  });

  it('rejects an empty api_key', async () => {
    const { svc, put } = make();
    await expect(
      svc.setKey({ tenant_id: TENANT, actor_id: ACTOR, provider: 'anthropic', api_key: '   ', requestId: 'rq' }),
    ).rejects.toBeInstanceOf(AramoError);
    expect(put).not.toHaveBeenCalled();
  });

  it('clearKey writes a TOMBSTONE (not delete) for the provider and invalidates it', async () => {
    const { svc, put, invalidate } = make();
    await svc.clearKey({ tenant_id: TENANT, actor_id: ACTOR, provider: 'anthropic' });
    expect(put).toHaveBeenCalledWith(ANTHROPIC_ID, TENANT_LLM_TOMBSTONE);
    expect(invalidate).toHaveBeenCalledWith(TENANT, 'anthropic');
  });

  it('status = configured per provider (value → true, tombstone/absent → false), never the value', async () => {
    expect(await make({ readValue: 'sk-real' }).svc.status(TENANT, 'openai')).toEqual({ provider: 'openai', configured: true });
    expect(await make({ readValue: TENANT_LLM_TOMBSTONE }).svc.status(TENANT, 'anthropic')).toEqual({ provider: 'anthropic', configured: false });
    expect(await make({ readValue: new Error('ResourceNotFound') }).svc.status(TENANT, 'openai')).toEqual({ provider: 'openai', configured: false });
    const out = await make({ readValue: 'sk-real' }).svc.status(TENANT, 'anthropic');
    expect(JSON.stringify(out)).not.toContain('sk-real');
  });

  it('getActiveProvider reads the llm.active_provider setting (default anthropic)', async () => {
    const { svc, settingsGet } = make({ activeProvider: 'openai' });
    expect(await svc.getActiveProvider(TENANT)).toBe('openai');
    expect(settingsGet).toHaveBeenCalledWith(TENANT, 'llm.active_provider');
  });

  it('setActiveProvider writes the setting (validated store) + audits, never a raw value', async () => {
    const { svc, settingsSet, log } = make();
    await svc.setActiveProvider({ tenant_id: TENANT, actor_id: ACTOR, provider: 'openai', requestId: 'rq' });
    expect(settingsSet).toHaveBeenCalledWith(TENANT, 'llm.active_provider', 'openai', ACTOR, 'rq');
    expect(log.mock.calls.at(-1)?.[0]).toMatchObject({ event: 'tenant_llm.active_provider_set', provider: 'openai' });
  });

  it('overview returns the active provider + per-wired-provider status', async () => {
    const { svc } = make({ readValue: new Error('ResourceNotFound'), activeProvider: 'anthropic' });
    const ov = await svc.overview(TENANT);
    expect(ov.active_provider).toBe('anthropic');
    expect(ov.providers.map((p) => p.provider).sort()).toEqual(['anthropic', 'openai']);
    expect(ov.providers.every((p) => p.configured === false)).toBe(true);
  });
});
