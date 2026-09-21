import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ResourceNotFoundException,
  DecryptionFailure,
  InternalServiceError,
  InvalidParameterException,
} from '@aws-sdk/client-secrets-manager';
import { AramoError } from '@aramo/common';

import { SecretCacheService } from '../lib/secrets/secret-cache.service.js';
import { LlmKeyNotConfiguredError } from '../lib/secrets/llm-key-not-configured.error.js';

// TENANT-LLM-1 — SecretCacheService is now PER-TENANT. Validates: tenant-scoped
// secret id + per-tenant cache + tenant isolation; not-configured (missing/empty
// secret) → terminal LlmKeyNotConfiguredError (NOT a platform fallback); the env
// fallback is HARD-GATED to ARAMO_ENV=local; AWS error-class translation.

interface InternalService {
  smClient: { send: ReturnType<typeof vi.fn> } | null;
}

function setSend(service: SecretCacheService, send: ReturnType<typeof vi.fn>): void {
  (service as unknown as InternalService).smClient = { send };
}

const TA = '11111111-1111-7111-8111-111111111111';
const TB = '22222222-2222-7222-8222-222222222222';

describe('SecretCacheService (TENANT-LLM-1 per-tenant)', () => {
  let savedEnv: string | undefined;
  let savedRegion: string | undefined;
  let savedKey: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['ARAMO_ENV'];
    savedRegion = process.env['AWS_REGION'];
    savedKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ARAMO_ENV'] = 'dev'; // non-local → the env fallback is inert
    process.env['AWS_REGION'] = 'us-east-1';
    delete process.env['ANTHROPIC_API_KEY'];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env['ARAMO_ENV'];
    else process.env['ARAMO_ENV'] = savedEnv;
    if (savedRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = savedRegion;
    if (savedKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedKey;
  });

  it('resolves the tenant-scoped secret id aramo/<env>/tenant-llm/<tenant>/anthropic-api-key', async () => {
    const service = new SecretCacheService();
    const send = vi.fn().mockResolvedValue({ SecretString: 'sk-ant-a' });
    setSend(service, send);

    const key = await service.getAnthropicApiKey(TA);

    expect(key).toBe('sk-ant-a');
    const sentId = send.mock.calls[0][0].input.SecretId;
    expect(sentId).toBe(`aramo/dev/tenant-llm/${TA}/anthropic-api-key`);
  });

  it('caches per tenant and does NOT bleed tenant A key into tenant B', async () => {
    const service = new SecretCacheService();
    const send = vi
      .fn()
      .mockImplementation((cmd: { input: { SecretId: string } }) =>
        Promise.resolve({
          SecretString: cmd.input.SecretId.includes(TA) ? 'sk-ant-A' : 'sk-ant-B',
        }),
      );
    setSend(service, send);

    expect(await service.getAnthropicApiKey(TA)).toBe('sk-ant-A');
    expect(await service.getAnthropicApiKey(TA)).toBe('sk-ant-A'); // cached
    expect(await service.getAnthropicApiKey(TB)).toBe('sk-ant-B'); // distinct
    // TA fetched once (cached second call), TB fetched once → 2 total, never A→B.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('missing secret (ResourceNotFound) → terminal LlmKeyNotConfiguredError, NOT a fallback', async () => {
    const service = new SecretCacheService();
    const err = new ResourceNotFoundException({ message: 'not found', $metadata: {} });
    setSend(service, vi.fn().mockRejectedValue(err));
    // env fallback key present but env is 'dev' → MUST NOT be used (no cross-tenant fallback).
    process.env['ANTHROPIC_API_KEY'] = 'sk-platform-should-never-be-used';

    await expect(service.getAnthropicApiKey(TA)).rejects.toBeInstanceOf(LlmKeyNotConfiguredError);
  });

  it('empty secret string → terminal LlmKeyNotConfiguredError', async () => {
    const service = new SecretCacheService();
    setSend(service, vi.fn().mockResolvedValue({ SecretString: '' }));
    await expect(service.getAnthropicApiKey(TA)).rejects.toBeInstanceOf(LlmKeyNotConfiguredError);
  });

  it('invalidate(tenant) drops the cache so the next call re-fetches', async () => {
    const service = new SecretCacheService();
    const send = vi.fn().mockResolvedValue({ SecretString: 'sk-ant-a' });
    setSend(service, send);

    await service.getAnthropicApiKey(TA);
    service.invalidate(TA);
    await service.getAnthropicApiKey(TA);

    expect(send).toHaveBeenCalledTimes(2); // re-fetched after invalidation
  });

  it('requires a tenant_id', async () => {
    const service = new SecretCacheService();
    await expect(service.getAnthropicApiKey('')).rejects.toBeInstanceOf(AramoError);
  });

  it('env fallback is HARD-GATED to ARAMO_ENV=local', async () => {
    // local → env key used, no Secrets Manager round-trip.
    process.env['ARAMO_ENV'] = 'local';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-local';
    const localSvc = new SecretCacheService();
    const localSend = vi.fn();
    setSend(localSvc, localSend);
    expect(await localSvc.getAnthropicApiKey(TA)).toBe('sk-ant-local');
    expect(localSend).not.toHaveBeenCalled();

    // dev → env key IGNORED; goes to Secrets Manager (no cross-tenant platform key).
    process.env['ARAMO_ENV'] = 'dev';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-should-be-ignored';
    const devSvc = new SecretCacheService();
    const devSend = vi.fn().mockResolvedValue({ SecretString: 'sk-ant-from-sm' });
    setSend(devSvc, devSend);
    expect(await devSvc.getAnthropicApiKey(TA)).toBe('sk-ant-from-sm');
    expect(devSend).toHaveBeenCalledTimes(1);
  });

  it('throws AramoError when ARAMO_ENV is not set', async () => {
    delete process.env['ARAMO_ENV'];
    const service = new SecretCacheService();
    await expect(service.getAnthropicApiKey(TA)).rejects.toBeInstanceOf(AramoError);
  });

  it('translates DecryptionFailure to AramoError kind=secret_decryption_failed', async () => {
    const service = new SecretCacheService();
    setSend(service, vi.fn().mockRejectedValue(new DecryptionFailure({ message: 'x', $metadata: {} })));
    try {
      await service.getAnthropicApiKey(TA);
      expect.fail('expected AramoError');
    } catch (e) {
      expect((e as AramoError).context.details?.['kind']).toBe('secret_decryption_failed');
    }
  });

  it('translates InternalServiceError to AramoError kind=aws_internal_error (502)', async () => {
    const service = new SecretCacheService();
    setSend(service, vi.fn().mockRejectedValue(new InternalServiceError({ message: 'x', $metadata: {} })));
    try {
      await service.getAnthropicApiKey(TA);
      expect.fail('expected AramoError');
    } catch (e) {
      expect((e as AramoError).context.details?.['kind']).toBe('aws_internal_error');
      expect((e as AramoError).statusCode).toBe(502);
    }
  });

  it('translates InvalidParameterException to AramoError kind=secret_request_invalid', async () => {
    const service = new SecretCacheService();
    setSend(service, vi.fn().mockRejectedValue(new InvalidParameterException({ message: 'x', $metadata: {} })));
    try {
      await service.getAnthropicApiKey(TA);
      expect.fail('expected AramoError');
    } catch (e) {
      expect((e as AramoError).context.details?.['kind']).toBe('secret_request_invalid');
    }
  });
});
