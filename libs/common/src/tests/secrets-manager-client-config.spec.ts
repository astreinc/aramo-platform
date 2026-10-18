import { describe, expect, it } from 'vitest';

import { secretsManagerClientConfig } from '../lib/aws/secrets-manager-client-config.js';

describe('secretsManagerClientConfig', () => {
  it('uses the real AWS region with no override (production and default)', () => {
    expect(secretsManagerClientConfig({ AWS_REGION: 'us-east-1', NODE_ENV: 'production' })).toEqual({ region: 'us-east-1' });
    expect(secretsManagerClientConfig({})).toEqual({ region: 'us-east-1' });
  });

  it('points at LocalStack with dummy credentials on a local box', () => {
    expect(secretsManagerClientConfig({ AWS_SECRETS_MANAGER_ENDPOINT: 'http://localhost:4566', ARAMO_ENV: 'local' })).toEqual({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });

  it('refuses the override in production or outside local/test', () => {
    expect(() => secretsManagerClientConfig({ AWS_SECRETS_MANAGER_ENDPOINT: 'http://x', ARAMO_ENV: 'local', NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => secretsManagerClientConfig({ AWS_SECRETS_MANAGER_ENDPOINT: 'http://x', ARAMO_ENV: 'prod' })).toThrow(/ARAMO_ENV=local/);
    expect(() => secretsManagerClientConfig({ AWS_SECRETS_MANAGER_ENDPOINT: 'http://x' })).toThrow(/ARAMO_ENV=local/);
  });
});
