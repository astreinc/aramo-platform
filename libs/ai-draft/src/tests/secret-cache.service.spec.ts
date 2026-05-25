import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ResourceNotFoundException,
  DecryptionFailure,
  InternalServiceError,
  InvalidParameterException,
} from '@aws-sdk/client-secrets-manager';
import { AramoError } from '@aramo/common';

import { SecretCacheService } from '../lib/secrets/secret-cache.service.js';

// M5 PR-5 §4.15 — SecretCacheService unit spec. Validates lazy fetch,
// in-process caching, and AWS error-class translation to AramoError.

interface InternalService {
  smClient: { send: ReturnType<typeof vi.fn> } | null;
  cachedApiKey: string | null;
}

function setSend(service: SecretCacheService, send: ReturnType<typeof vi.fn>): void {
  (service as unknown as InternalService).smClient = { send };
}

describe('SecretCacheService', () => {
  let savedEnv: string | undefined;
  let savedRegion: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['ARAMO_ENV'];
    savedRegion = process.env['AWS_REGION'];
    process.env['ARAMO_ENV'] = 'dev';
    process.env['AWS_REGION'] = 'us-east-1';
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env['ARAMO_ENV'];
    else process.env['ARAMO_ENV'] = savedEnv;
    if (savedRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = savedRegion;
  });

  it('throws AramoError when ARAMO_ENV is not set', async () => {
    delete process.env['ARAMO_ENV'];
    const service = new SecretCacheService();
    await expect(service.getAnthropicApiKey()).rejects.toBeInstanceOf(AramoError);
  });

  it('fetches the secret on first call and caches for subsequent calls', async () => {
    const service = new SecretCacheService();
    const send = vi.fn().mockResolvedValue({ SecretString: 'sk-ant-abc' });
    setSend(service, send);

    const first = await service.getAnthropicApiKey();
    const second = await service.getAnthropicApiKey();

    expect(first).toBe('sk-ant-abc');
    expect(second).toBe('sk-ant-abc');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('translates ResourceNotFoundException to AramoError kind=secret_not_found', async () => {
    const service = new SecretCacheService();
    const err = new ResourceNotFoundException({
      message: 'Secrets Manager can not find the specified secret.',
      $metadata: {},
    });
    setSend(service, vi.fn().mockRejectedValue(err));

    try {
      await service.getAnthropicApiKey();
      expect.fail('expected AramoError');
    } catch (e) {
      expect(e).toBeInstanceOf(AramoError);
      const ae = e as AramoError;
      expect(ae.code).toBe('INTERNAL_ERROR');
      expect(ae.context.details?.['kind']).toBe('secret_not_found');
    }
  });

  it('translates DecryptionFailure to AramoError kind=secret_decryption_failed', async () => {
    const service = new SecretCacheService();
    const err = new DecryptionFailure({ message: 'decrypt failed', $metadata: {} });
    setSend(service, vi.fn().mockRejectedValue(err));

    try {
      await service.getAnthropicApiKey();
      expect.fail('expected AramoError');
    } catch (e) {
      expect(e).toBeInstanceOf(AramoError);
      expect((e as AramoError).context.details?.['kind']).toBe('secret_decryption_failed');
    }
  });

  it('translates InternalServiceError to AramoError kind=aws_internal_error', async () => {
    const service = new SecretCacheService();
    const err = new InternalServiceError({ message: 'aws internal', $metadata: {} });
    setSend(service, vi.fn().mockRejectedValue(err));

    try {
      await service.getAnthropicApiKey();
      expect.fail('expected AramoError');
    } catch (e) {
      expect((e as AramoError).context.details?.['kind']).toBe('aws_internal_error');
      expect((e as AramoError).statusCode).toBe(502);
    }
  });

  it('translates InvalidParameterException to AramoError kind=secret_request_invalid', async () => {
    const service = new SecretCacheService();
    const err = new InvalidParameterException({ message: 'bad param', $metadata: {} });
    setSend(service, vi.fn().mockRejectedValue(err));

    try {
      await service.getAnthropicApiKey();
      expect.fail('expected AramoError');
    } catch (e) {
      expect((e as AramoError).context.details?.['kind']).toBe('secret_request_invalid');
    }
  });
});
