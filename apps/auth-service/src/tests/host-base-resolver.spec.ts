import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantService } from '@aramo/identity';

import type { HostAuthProfileService } from '../app/auth/host-auth-profile.service.js';
import { HostBaseResolver } from '../app/auth/host-base-resolver.service.js';
import { IdentityHostContextAdapter } from '../app/auth/identity-host-context.adapter.js';

// Auth-Decoupling PR-5a (§4.1) — HostBaseResolver now depends on the
// HostContextDirectory port; `make` wraps the SAME tenants mock in the REAL
// IdentityHostContextAdapter, so every findActiveBySlug assertion still fires from
// the far side of the boundary (provider-substitution-only, zero assertion changes).

// PR-3.1 §3a — the resolver folds the tenant-host validation AND the HRD IdP
// hint into ONE findActiveBySlug (the sharing choice), and fails open.
//
// Auth-Decoupling PR-1 — these specs assert the LEGACY derivation (the fall-
// through path). A registry that always MISSES (returns null) forces that path,
// so their intent is unchanged; the registry-active path is covered by the
// host-auth-profile.* specs. (An empty registry misses without touching
// findActiveBySlug, so the "ONE lookup" invariant below still holds.)
const missingRegistry = {
  resolve: async (): Promise<null> => null,
} as unknown as HostAuthProfileService;

const ENV = ['AUTH_PLATFORM_HOSTS', 'AUTH_ALLOW_INSECURE_COOKIES', 'NODE_ENV', 'APP_ROOT_DOMAIN'] as const;
let saved: Partial<Record<string, string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env['APP_ROOT_DOMAIN'] = 'aramo.ai';
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function make(findActiveBySlug: ReturnType<typeof vi.fn>): {
  resolver: HostBaseResolver;
  findActiveBySlug: ReturnType<typeof vi.fn>;
} {
  const tenants = { findActiveBySlug } as unknown as TenantService;
  const hostContext = new IdentityHostContextAdapter(tenants);
  return { resolver: new HostBaseResolver(hostContext, missingRegistry), findActiveBySlug };
}

describe('HostBaseResolver.resolve', () => {
  it('TENANT host: ONE findActiveBySlug yields BOTH derivedBase (https) and the IdP hint', async () => {
    const findActiveBySlug = vi.fn().mockResolvedValue({ identity_provider: 'microsoft' });
    const { resolver } = make(findActiveBySlug);
    const out = await resolver.resolve('astre.aramo.ai');
    expect(out).toEqual({ derivedBase: 'https://astre.aramo.ai', identityProvider: 'microsoft' });
    // The SHARING invariant: exactly one lookup for both signals.
    expect(findActiveBySlug).toHaveBeenCalledTimes(1);
    expect(findActiveBySlug).toHaveBeenCalledWith('astre');
  });

  it('TENANT host with null IdP: derives base, IdP null (chooser)', async () => {
    const { resolver } = make(vi.fn().mockResolvedValue({ identity_provider: null }));
    expect(await resolver.resolve('astre.aramo.ai')).toEqual({
      derivedBase: 'https://astre.aramo.ai',
      identityProvider: null,
    });
  });

  it('UNKNOWN/inactive slug (findActiveBySlug null): no base, no IdP', async () => {
    const { resolver } = make(vi.fn().mockResolvedValue(null));
    expect(await resolver.resolve('ghost.aramo.ai')).toEqual({ derivedBase: null, identityProvider: null });
  });

  it('PLATFORM host: derives https base WITHOUT a tenant lookup', async () => {
    process.env['AUTH_PLATFORM_HOSTS'] = 'admin.aramo.ai';
    const findActiveBySlug = vi.fn().mockResolvedValue(null);
    const { resolver } = make(findActiveBySlug);
    const out = await resolver.resolve('admin.aramo.ai');
    // admin is a reserved slug → extractTenantSlugFromHost yields null → no DB call.
    expect(out.derivedBase).toBe('https://admin.aramo.ai');
    expect(out.identityProvider).toBeNull();
  });

  it('DEV localhost under dev posture: derives http base, no DB call', async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['AUTH_ALLOW_INSECURE_COOKIES'] = 'true';
    const findActiveBySlug = vi.fn();
    const { resolver } = make(findActiveBySlug);
    expect((await resolver.resolve('localhost:4202')).derivedBase).toBe('http://localhost:4202');
    expect(findActiveBySlug).not.toHaveBeenCalled();
  });

  it('HOSTILE host: no base, no IdP (open-redirect refused)', async () => {
    const { resolver } = make(vi.fn().mockResolvedValue(null));
    expect(await resolver.resolve('evil.com')).toEqual({ derivedBase: null, identityProvider: null });
  });

  it('FAILS OPEN on a lookup error (a user must always reach a login)', async () => {
    const { resolver } = make(vi.fn().mockRejectedValue(new Error('db down')));
    expect(await resolver.resolve('astre.aramo.ai')).toEqual({ derivedBase: null, identityProvider: null });
  });
});
