import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  ConfigurableTestResolver,
  generateTestKeyPair,
  signCompactAccessToken,
} from './test-auth-harness.js';

// HF-AUTH-1 — self-test for the shared test-auth harness. Also proves an
// acceptance-bar item directly: a harness-minted token carries NO `scopes` claim
// (the old scope-in-token shape cannot re-enter through the test substrate).
describe('test-auth-harness (HF-AUTH-1)', () => {
  it('mints a COMPACT token with authz_version and NO scopes claim', async () => {
    const { privatePem } = await generateTestKeyPair();
    const jwt = await signCompactAccessToken({
      privatePem,
      audience: 'https://astre.aramo.ai',
      sub: 'user-1',
      tenant_id: 'tenant-1',
      authz_version: 7,
    });
    const claims = decodeJwt(jwt);
    expect(claims['scopes']).toBeUndefined();
    expect(claims['authz_version']).toBe(7);
    expect(claims['sub']).toBe('user-1');
    expect(claims['tenant_id']).toBe('tenant-1');
    expect(claims['consumer_type']).toBe('recruiter');
  });

  it('defaults authz_version to 1 and consumer_type to recruiter; stamps site_id when given', async () => {
    const { privatePem } = await generateTestKeyPair();
    const jwt = await signCompactAccessToken({
      privatePem,
      audience: 'aud',
      sub: 's',
      tenant_id: 't',
      site_id: 'site-9',
    });
    const claims = decodeJwt(jwt);
    expect(claims['authz_version']).toBe(1);
    expect(claims['site_id']).toBe('site-9');
    expect(claims['scopes']).toBeUndefined();
  });

  it('grant is version-keyed (same principal, two scope sets, no collision); [] when unset; forced statuses win', async () => {
    const resolver = new ConfigurableTestResolver();
    // Same principal, granted twice with DIFFERENT scopes → distinct versions.
    const vFull = resolver.grant('t', 'u', ['requisition:create', 'pipeline:read']);
    const vNone = resolver.grant('t', 'u', []);
    resolver.force('t', 'stale-user', 'stale');
    resolver.force('t', 'down-user', 'unresolvable');
    const base = { consumer_type: 'recruiter' as const, actor_kind: 'user' as const };

    await expect(
      resolver.resolve({ tenant_id: 't', principal_id: 'u', token_authz_version: vFull, ...base }),
    ).resolves.toEqual({ status: 'ok', scopes: ['requisition:create', 'pipeline:read'] });
    // The SAME principal at the other token's version resolves to ITS own (empty) set.
    await expect(
      resolver.resolve({ tenant_id: 't', principal_id: 'u', token_authz_version: vNone, ...base }),
    ).resolves.toEqual({ status: 'ok', scopes: [] });
    await expect(
      resolver.resolve({ tenant_id: 't', principal_id: 'nobody', token_authz_version: 1, ...base }),
    ).resolves.toEqual({ status: 'ok', scopes: [] });
    await expect(
      resolver.resolve({ tenant_id: 't', principal_id: 'stale-user', token_authz_version: 1, ...base }),
    ).resolves.toEqual({ status: 'stale' });
    await expect(
      resolver.resolve({ tenant_id: 't', principal_id: 'down-user', token_authz_version: 1, ...base }),
    ).resolves.toEqual({ status: 'unresolvable' });
  });
});
