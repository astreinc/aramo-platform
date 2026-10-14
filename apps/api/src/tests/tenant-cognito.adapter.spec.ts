import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';

import { TenantCognitoAdapter } from '../cognito/tenant-cognito.adapter.js';

// IC-3 PR-7 — the ENABLE leg's IdP contract: AdminEnableUser; a missing IdP
// account (an invitee who never completed a federated login) is a NO-OP
// success (the adminDeleteUser contract); every other failure propagates so
// the lifecycle saga compensates. The SDK client is replaced by a stub.
describe('TenantCognitoAdapter.adminEnableUser (IC-3 PR-7)', () => {
  const saved = process.env['AUTH_COGNITO_TENANT_USER_POOL_ID'];
  beforeEach(() => {
    process.env['AUTH_COGNITO_TENANT_USER_POOL_ID'] = 'us-east-1_test';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['AUTH_COGNITO_TENANT_USER_POOL_ID'];
    else process.env['AUTH_COGNITO_TENANT_USER_POOL_ID'] = saved;
  });
  function adapterWith(send: ReturnType<typeof vi.fn>): TenantCognitoAdapter {
    const adapter = new TenantCognitoAdapter();
    (adapter as unknown as { client: { send: ReturnType<typeof vi.fn> } }).client = { send };
    return adapter;
  }

  it('sends AdminEnableUser for the tenant pool + email (Username)', async () => {
    const send = vi.fn().mockResolvedValue({});
    await adapterWith(send).adminEnableUser({ email: 'u@acme.io' });
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]![0] as { input: { UserPoolId: string; Username: string } };
    expect(cmd.input).toEqual({ UserPoolId: 'us-east-1_test', Username: 'u@acme.io' });
  });

  it('UserNotFoundException (no IdP account) → resolves (no-op success)', async () => {
    const send = vi.fn().mockRejectedValue(new UserNotFoundException({ message: 'no such user', $metadata: {} }));
    await expect(adapterWith(send).adminEnableUser({ email: 'never-logged-in@acme.io' })).resolves.toBeUndefined();
  });

  it('any other IdP failure propagates (the lifecycle saga compensates)', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ThrottlingException'));
    await expect(adapterWith(send).adminEnableUser({ email: 'u@acme.io' })).rejects.toThrow('ThrottlingException');
  });

  it('fails loud when the tenant pool id is not configured', async () => {
    delete process.env['AUTH_COGNITO_TENANT_USER_POOL_ID'];
    await expect(adapterWith(vi.fn()).adminEnableUser({ email: 'u@acme.io' })).rejects.toThrow('AUTH_COGNITO_TENANT_USER_POOL_ID');
  });
});
