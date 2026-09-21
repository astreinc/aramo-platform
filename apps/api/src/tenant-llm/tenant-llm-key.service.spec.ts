import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import { TenantLlmKeyService } from './tenant-llm-key.service.js';
import { TENANT_LLM_TOMBSTONE } from './tenant-llm-secret-ref.js';

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '22222222-2222-7222-8222-222222222222';
const SECRET_ID = `aramo/test/tenant-llm/${TENANT}/anthropic-api-key`;

function make(readValue?: string | Error) {
  const put = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockImplementation(async () => {
    if (readValue instanceof Error) throw readValue;
    if (readValue === undefined) throw new Error('ResourceNotFound');
    return readValue;
  });
  const invalidate = vi.fn();
  const log = vi.fn();
  const svc = new TenantLlmKeyService(
    { putSecretValue: put } as never,
    { getSecretValue: get } as never,
    { invalidate } as never,
    { log, warn: vi.fn(), error: vi.fn() } as never,
  );
  return { svc, put, get, invalidate, log };
}

describe('TenantLlmKeyService (TENANT-LLM-1 §P2)', () => {
  beforeEach(() => {
    process.env['ARAMO_ENV'] = 'test';
  });

  it('setKey writes the value to the server-derived secret id and invalidates the cache', async () => {
    const { svc, put, invalidate } = make();
    await svc.setKey({ tenant_id: TENANT, actor_id: ACTOR, api_key: 'sk-ant-secret', requestId: 'rq' });
    expect(put).toHaveBeenCalledWith(SECRET_ID, 'sk-ant-secret');
    expect(invalidate).toHaveBeenCalledWith(TENANT); // rotation-correct
  });

  it('setKey audits actor+tenant+action but NEVER the key value or its length', async () => {
    const { svc, log } = make();
    await svc.setKey({ tenant_id: TENANT, actor_id: ACTOR, api_key: 'sk-ant-super-secret', requestId: 'rq' });
    const evt = log.mock.calls[0][0];
    expect(evt).toMatchObject({ event: 'tenant_llm.key_set', tenant_id: TENANT, actor_id: ACTOR });
    const serialized = JSON.stringify(evt);
    expect(serialized).not.toContain('sk-ant-super-secret');
    expect(serialized).not.toContain('length');
  });

  it('rejects an empty api_key', async () => {
    const { svc, put } = make();
    await expect(
      svc.setKey({ tenant_id: TENANT, actor_id: ACTOR, api_key: '   ', requestId: 'rq' }),
    ).rejects.toBeInstanceOf(AramoError);
    expect(put).not.toHaveBeenCalled();
  });

  it('clearKey writes a TOMBSTONE (not delete) and invalidates the cache', async () => {
    const { svc, put, invalidate } = make();
    await svc.clearKey({ tenant_id: TENANT, actor_id: ACTOR });
    expect(put).toHaveBeenCalledWith(SECRET_ID, TENANT_LLM_TOMBSTONE);
    expect(invalidate).toHaveBeenCalledWith(TENANT);
  });

  it('status = configured:true when a real value exists', async () => {
    const { svc } = make('sk-ant-real');
    expect(await svc.status(TENANT)).toEqual({ provider: 'anthropic', configured: true });
  });

  it('status = configured:false for a tombstone', async () => {
    const { svc } = make(TENANT_LLM_TOMBSTONE);
    expect(await svc.status(TENANT)).toEqual({ provider: 'anthropic', configured: false });
  });

  it('status = configured:false when the secret is absent (reader throws)', async () => {
    const { svc } = make(new Error('ResourceNotFound'));
    expect(await svc.status(TENANT)).toEqual({ provider: 'anthropic', configured: false });
  });

  it('status NEVER returns the key value (has-key boolean only)', async () => {
    const { svc } = make('sk-ant-real');
    const out = await svc.status(TENANT);
    expect(JSON.stringify(out)).not.toContain('sk-ant-real');
  });
});
