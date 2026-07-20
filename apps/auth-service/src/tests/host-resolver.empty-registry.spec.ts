import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLATFORM_HOST } from '@aramo/auth-storage';

import {
  fakeTenantService,
  resolverFaulting,
  resolverLegacy,
} from './host-auth-profile.test-fixtures.js';

// Auth-Decoupling PR-5a §4.4 — THE PRODUCTION CONFIGURATION. The host_auth_profile
// registry migrated to prod but was NEVER seeded (R-P5a-3): it is EMPTY, so every
// host resolves via the legacy derivation + retained env chain, now through the
// HostContextDirectory port. A regression here is a total login outage on both
// live hosts — this spec proves the empty-registry path still resolves every host
// class. (Also §4.3: a throwing host adapter still yields a usable base.)

const ENV = ['AUTH_PLATFORM_HOSTS', 'APP_ROOT_DOMAIN', 'AUTH_PUBLIC_BASE_URL'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV) saved[k] = process.env[k];
  process.env['AUTH_PLATFORM_HOSTS'] = DEFAULT_PLATFORM_HOST;
  process.env['APP_ROOT_DOMAIN'] = 'aramo.ai';
  delete process.env['AUTH_PUBLIC_BASE_URL'];
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const tenants = () => fakeTenantService({ astre: { identity_provider: 'AstreSAML' } });

describe('§4.4 — empty registry (prod config): env chain + host port still resolve', () => {
  it('TENANT host resolves via the HostContextDirectory fall-through', async () => {
    const r = await resolverLegacy(tenants()).resolve('astre.aramo.ai');
    expect(r).toEqual({ derivedBase: 'https://astre.aramo.ai', identityProvider: 'AstreSAML' });
  });

  it('PLATFORM host resolves via the env allow-list (no tenant read)', async () => {
    const r = await resolverLegacy(tenants()).resolve(DEFAULT_PLATFORM_HOST);
    expect(r).toEqual({ derivedBase: `https://${DEFAULT_PLATFORM_HOST}`, identityProvider: null });
  });

  it('unknown host → null base (env fallback, no AUTH_PUBLIC_BASE_URL set)', async () => {
    const r = await resolverLegacy(tenants()).resolve('evil.com');
    expect(r).toEqual({ derivedBase: null, identityProvider: null });
  });
});

describe('§4.3 — a throwing host adapter still yields a usable base (fail-open)', () => {
  it('registry throws AND the host read is exercised → platform host still derives', async () => {
    // resolverFaulting = registry throws; the fall-through host read then runs.
    const r = await resolverFaulting(tenants()).resolve(DEFAULT_PLATFORM_HOST);
    expect(r.derivedBase).toBe(`https://${DEFAULT_PLATFORM_HOST}`);
  });
});
