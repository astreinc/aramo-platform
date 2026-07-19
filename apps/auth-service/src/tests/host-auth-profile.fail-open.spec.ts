import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLATFORM_HOST, DEFAULT_PORTAL_HOST } from '@aramo/auth-storage';

import {
  fakeTenantService,
  resolverFaulting,
  resolverLegacy,
} from './host-auth-profile.test-fixtures.js';

// Auth-Decoupling PR-1 §3.2 — FAIL-OPEN, proven by FAULT INJECTION (not
// inspection). R-A1-2: a registry ERROR and a registry MISS must each fall
// through to the legacy path and still yield a usable base. Fail-closed is a
// PR-5 question and must NOT be introduced.

const ENV_KEYS = [
  'AUTH_PLATFORM_HOSTS',
  'AUTH_PORTAL_HOSTS',
  'APP_ROOT_DOMAIN',
  'NODE_ENV',
  'AUTH_ALLOW_INSECURE_COOKIES',
  'AUTH_PUBLIC_BASE_URL',
] as const;

describe('Auth-Decoupling PR-1 §3.2 — registry fail-open', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env['AUTH_PLATFORM_HOSTS'] = DEFAULT_PLATFORM_HOST;
    process.env['AUTH_PORTAL_HOSTS'] = DEFAULT_PORTAL_HOST;
    process.env['APP_ROOT_DOMAIN'] = 'aramo.ai';
    process.env['NODE_ENV'] = 'test';
    process.env['AUTH_ALLOW_INSECURE_COOKIES'] = 'true';
    delete process.env['AUTH_PUBLIC_BASE_URL'];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const tenants = () => fakeTenantService({ astre: { identity_provider: 'AstreSAML' } });

  it('registry ERROR (throwing store) → platform host still derives via legacy', async () => {
    const t = tenants();
    const faulting = await resolverFaulting(t).resolve('admin.aramo.ai');
    const legacy = await resolverLegacy(t).resolve('admin.aramo.ai');
    expect(faulting.derivedBase).toBe('https://admin.aramo.ai'); // usable, not null
    expect(faulting).toEqual(legacy); // identical to the fall-through path
  });

  it('registry ERROR (throwing store) → tenant host still derives + keeps idp', async () => {
    const t = tenants();
    const faulting = await resolverFaulting(t).resolve('astre.aramo.ai');
    const legacy = await resolverLegacy(t).resolve('astre.aramo.ai');
    expect(faulting.derivedBase).toBe('https://astre.aramo.ai');
    expect(faulting.identityProvider).toBe('AstreSAML');
    expect(faulting).toEqual(legacy);
  });

  it('registry ERROR never rejects — resolve resolves, does not throw', async () => {
    const t = tenants();
    await expect(resolverFaulting(t).resolve('admin.aramo.ai')).resolves.toBeDefined();
  });

  it('registry MISS (empty store) → platform host still derives via legacy', async () => {
    // resolverLegacy IS the empty-registry wiring; a miss falls through.
    const t = tenants();
    const miss = await resolverLegacy(t).resolve('admin.aramo.ai');
    expect(miss.derivedBase).toBe('https://admin.aramo.ai');
  });
});
