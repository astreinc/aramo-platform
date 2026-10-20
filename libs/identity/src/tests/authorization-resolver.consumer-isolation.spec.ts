import { describe, expect, it, vi } from 'vitest';
import type { EffectiveAuthorizationInput } from '@aramo/auth';

import type { AuthorizationVersionService } from '../lib/authorization-version.service.js';
import type { RoleService } from '../lib/role.service.js';
import type { TenantEntitlementReader } from '../lib/tenant-entitlement-reader.service.js';
import { IdentityEffectiveAuthorizationResolver } from '../lib/authorization/identity-effective-authorization-resolver.js';
import { InMemoryScopeCache } from '../lib/authorization/in-memory-scope-cache.js';

// IC-2 PR-6 — the resolver applies the per-consumer namespace filter AFTER the
// cached canonical set, reads the esign capability LIVE, and keys the cache by
// consumer. Nothing here can widen a token.
const T = '01900000-0000-7000-8000-0000000000aa';
const U = '01900000-0000-7000-8000-000000000001';
const CANONICAL = ['talent:read', 'sign:envelope:read', 'platform:tenant:read', 'tenant:admin:profile'];

function build(over: { capabilities?: string[]; throws?: boolean; canonical?: string[] } = {}) {
  const getScopes = vi.fn().mockResolvedValue(over.canonical ?? CANONICAL);
  const roles = { getScopesByUserTenantAndSite: getScopes } as unknown as RoleService;
  const versions = { getCurrentVersion: vi.fn().mockResolvedValue(1) } as unknown as AuthorizationVersionService;
  const cache = new InMemoryScopeCache();
  const caps = { current: new Set(over.capabilities ?? ['core', 'ats', 'portal']) };
  const getCapabilities = vi.fn(async () => {
    if (over.throws === true) throw new Error('entitlement store down');
    return caps.current;
  });
  const entitlements = { getCapabilities } as unknown as TenantEntitlementReader;
  const resolver = new IdentityEffectiveAuthorizationResolver(roles, versions, cache, { portalScopes: ['portal:profile:read'], scopeCacheTtlSeconds: 300 }, entitlements);
  return { resolver, getScopes, getCapabilities, caps, cache };
}
const input = (consumer_type: EffectiveAuthorizationInput['consumer_type']): EffectiveAuthorizationInput => ({
  tenant_id: T, principal_id: U, consumer_type, actor_kind: 'user', token_authz_version: 1,
});

describe('IdentityEffectiveAuthorizationResolver — consumer isolation (IC-2 PR-6)', () => {
  it('recruiter: esign:* and platform:* are dropped; the entitlement store is NOT consulted', async () => {
    const { resolver, getCapabilities } = build();
    const r = await resolver.resolve(input('recruiter'));
    expect(r).toEqual({ status: 'ok', scopes: ['talent:read', 'tenant:admin:profile'] });
    expect(getCapabilities).not.toHaveBeenCalled();
  });
  it('esign with the esign capability: esign:* + the organization subset; without it: NOTHING (live read, every request)', async () => {
    const { resolver, caps, getCapabilities } = build({ capabilities: ['core', 'sign'] });
    expect(await resolver.resolve(input('sign'))).toEqual({ status: 'ok', scopes: ['sign:envelope:read', 'tenant:admin:profile'] });
    caps.current = new Set(['core']); // entitlement removed — no version bump, same cached canonical set
    expect(await resolver.resolve(input('sign'))).toEqual({ status: 'ok', scopes: [] });
    expect(getCapabilities).toHaveBeenCalledTimes(2);
  });
  it('esign: an unreadable entitlement store yields NO esign scopes (fail closed)', async () => {
    const { resolver } = build({ throws: true });
    expect(await resolver.resolve(input('sign'))).toEqual({ status: 'ok', scopes: [] });
  });
  it('platform: ONLY platform:* — tenant product scopes never ride a platform token', async () => {
    const { resolver } = build();
    expect(await resolver.resolve(input('platform'))).toEqual({ status: 'ok', scopes: ['platform:tenant:read'] });
  });
  it('ingestion behaves as the ATS family', async () => {
    const { resolver } = build();
    expect(await resolver.resolve(input('ingestion'))).toEqual({ status: 'ok', scopes: ['talent:read', 'tenant:admin:profile'] });
  });
  it('the cache is keyed by consumer: a recruiter snapshot never serves an esign request (and vice versa)', async () => {
    const { resolver, getScopes } = build({ capabilities: ['core', 'ats', 'sign'] });
    await resolver.resolve(input('recruiter'));
    await resolver.resolve(input('sign'));
    expect(getScopes).toHaveBeenCalledTimes(2); // two distinct cache keys
    expect(await resolver.resolve(input('recruiter'))).toEqual({ status: 'ok', scopes: ['talent:read', 'tenant:admin:profile'] });
    expect(await resolver.resolve(input('sign'))).toEqual({ status: 'ok', scopes: ['sign:envelope:read', 'tenant:admin:profile'] });
    expect(getScopes).toHaveBeenCalledTimes(2); // both served from their own snapshot
  });
  it('a cached snapshot never widens: filtering is applied on the cache HIT path too', async () => {
    const { resolver, cache } = build();
    // Poison the recruiter cache key with platform + esign scopes.
    await cache.set(`authz:${T}:${U}:1:-:recruiter`, ['platform:tenant:read', 'sign:envelope:send', 'talent:read'], 300);
    expect(await resolver.resolve(input('recruiter'))).toEqual({ status: 'ok', scopes: ['talent:read'] });
  });
  it('portal keeps the fixed set, version pinned to 1 (unchanged)', async () => {
    const { resolver } = build();
    expect(await resolver.resolve(input('portal'))).toEqual({ status: 'ok', scopes: ['portal:profile:read'] });
  });
});
