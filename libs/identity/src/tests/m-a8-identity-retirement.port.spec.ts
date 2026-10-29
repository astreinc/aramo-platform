import { describe, expect, it, vi } from 'vitest';

import {
  CognitoIdentityRetirement,
  NotConfiguredIdentityRetirement,
  cognitoFilterValue,
  identityRetirementFromEnv,
  linkedProviderCount,
} from '../lib/privacy/identity-retirement.port.js';

// Aramo-Sign-Mobile-Amendment-M-A8 §3.5 — the identity-owned retirement port and its one
// AWS adapter: the pool user is resolved BY `sub` (ListUsers filter) and deleted by its
// pool username; AdminUserGlobalSignOut is never sent; (e) lookup reads `identities` and
// other pool users with the same email. The Cognito client is a recorded fake.

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

function fakeClient(users: Array<{ Username: string; Attributes: Array<{ Name: string; Value: string }> }>, opts: { deleteError?: Error; listError?: Error } = {}) {
  const sent: Cmd[] = [];
  const send = vi.fn(async (c: Cmd) => {
    sent.push(c);
    if (c.constructor.name === 'ListUsersCommand') {
      if (opts.listError !== undefined) throw opts.listError;
      const m = /^(\w+) = "(.*)"$/.exec(String(c.input['Filter']));
      const [, name, value] = m ?? [];
      return { Users: users.filter((u) => u.Attributes.some((a) => a.Name === name && a.Value === value)) };
    }
    if (c.constructor.name === 'AdminDeleteUserCommand' && opts.deleteError !== undefined) throw opts.deleteError;
    return {};
  });
  return { client: { send } as never, sent };
}

const SUB = '11111111-2222-4333-8444-555555555555';
const googleUser = {
  Username: 'Google_1234567890',
  Attributes: [
    { Name: 'sub', Value: SUB },
    { Name: 'email', Value: 'pat@gmail.com' },
    { Name: 'identities', Value: JSON.stringify([{ providerName: 'Google', userId: '1234567890', providerType: 'Google' }]) },
  ],
};

describe('M-A8 §3.5 — identity retirement port (one AWS adapter)', () => {
  it('retire resolves the pool username by sub, then AdminDeleteUser on it — never a global sign-out', async () => {
    const { client, sent } = fakeClient([googleUser]);
    expect(await new CognitoIdentityRetirement('us-east-1_pool', client).retire({ cognito_sub: SUB })).toBe('deleted');
    expect(sent.map((c) => c.constructor.name)).toEqual(['ListUsersCommand', 'AdminDeleteUserCommand']);
    expect(sent[0]!.input).toMatchObject({ UserPoolId: 'us-east-1_pool', Filter: `sub = "${SUB}"` });
    expect(sent[1]!.input).toEqual({ UserPoolId: 'us-east-1_pool', Username: 'Google_1234567890' });
    expect(sent.some((c) => c.constructor.name === 'AdminUserGlobalSignOutCommand')).toBe(false);
  });

  it('retire: no pool user with that sub → not_found (nothing deleted); a vanished user → not_found; other errors → failed', async () => {
    const none = fakeClient([]);
    expect(await new CognitoIdentityRetirement('p', none.client).retire({ cognito_sub: SUB })).toBe('not_found');
    expect(none.sent.map((c) => c.constructor.name)).toEqual(['ListUsersCommand']);
    const gone = fakeClient([googleUser], { deleteError: Object.assign(new Error('x'), { name: 'UserNotFoundException' }) });
    expect(await new CognitoIdentityRetirement('p', gone.client).retire({ cognito_sub: SUB })).toBe('not_found');
    const denied = fakeClient([googleUser], { deleteError: Object.assign(new Error('x'), { name: 'AccessDeniedException' }) });
    expect(await new CognitoIdentityRetirement('p', denied.client).retire({ cognito_sub: SUB })).toBe('failed');
  });

  it('lookup: a federated user alone is clear; a linked provider or another pool user with the email is a dependency', async () => {
    const alone = fakeClient([googleUser]);
    expect(await new CognitoIdentityRetirement('p', alone.client).lookup({ cognito_sub: SUB, email: 'pat@gmail.com' })).toEqual({
      status: 'ok',
      subject_found: true,
      linked_providers: 0,
      other_users_same_email: 0,
    });
    expect(alone.sent.map((c) => c.input['Filter'])).toEqual([`sub = "${SUB}"`, 'email = "pat@gmail.com"']);

    const linked = {
      ...googleUser,
      Attributes: googleUser.Attributes.map((a) =>
        a.Name === 'identities' ? { ...a, Value: JSON.stringify([{ providerName: 'Google', userId: '1234567890' }, { providerName: 'microsoft', userId: 'abc' }]) } : a,
      ),
    };
    expect(await new CognitoIdentityRetirement('p', fakeClient([linked]).client).lookup({ cognito_sub: SUB })).toMatchObject({ linked_providers: 1 });

    const twin = { Username: 'microsoft_abc', Attributes: [{ Name: 'sub', Value: 'other-sub' }, { Name: 'email', Value: 'pat@gmail.com' }] };
    expect(await new CognitoIdentityRetirement('p', fakeClient([googleUser, twin]).client).lookup({ cognito_sub: SUB })).toMatchObject({ other_users_same_email: 1 });

    const missing = fakeClient([twin]);
    expect(await new CognitoIdentityRetirement('p', missing.client).lookup({ cognito_sub: SUB, email: 'pat@gmail.com' })).toEqual({
      status: 'ok',
      subject_found: false,
      linked_providers: 0,
      other_users_same_email: 1,
    });

    const broken = fakeClient([], { listError: new Error('AccessDenied') });
    expect(await new CognitoIdentityRetirement('p', broken.client).lookup({ cognito_sub: SUB })).toEqual({ status: 'failed' });
  });

  it('a native user with a provider linked into it counts the link; an unreadable identities attribute fails closed', () => {
    const native = { Username: SUB, Attributes: [{ Name: 'identities', Value: JSON.stringify([{ providerName: 'Google', userId: '9' }]) }] };
    expect(linkedProviderCount(native)).toBe(1);
    expect(linkedProviderCount({ Username: SUB, Attributes: [] })).toBe(0);
    expect(linkedProviderCount({ Username: SUB, Attributes: [{ Name: 'identities', Value: '{not json' }] })).toBe(1);
  });

  it('filter values are escaped', () => {
    expect(cognitoFilterValue('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it('no tenant pool configured → not_configured, nothing called', async () => {
    expect(identityRetirementFromEnv({})).toBeInstanceOf(NotConfiguredIdentityRetirement);
    expect(identityRetirementFromEnv({ AUTH_COGNITO_TENANT_USER_POOL_ID: '  ' })).toBeInstanceOf(NotConfiguredIdentityRetirement);
    expect(identityRetirementFromEnv({ AUTH_COGNITO_TENANT_USER_POOL_ID: 'us-east-1_x' })).toBeInstanceOf(CognitoIdentityRetirement);
    const nc = new NotConfiguredIdentityRetirement();
    expect(await nc.retire()).toBe('not_configured');
    expect(await nc.lookup()).toEqual({ status: 'not_configured' });
  });
});
