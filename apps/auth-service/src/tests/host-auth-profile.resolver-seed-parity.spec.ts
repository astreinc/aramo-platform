import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PLATFORM_HOST,
  DEFAULT_PORTAL_HOST,
  HOST_CLASSES,
  type HostClass,
} from '@aramo/auth-storage';
import type { TenantService } from '@aramo/identity';

import { IdentityHostContextAdapter } from '../app/auth/identity-host-context.adapter.js';

import { HostAuthProfileService, fakeStore } from './host-auth-profile.test-fixtures.js';

// Auth-Decoupling PR-1 §3.3 (resolver side) — every host_class the CLASSIFIER can
// produce has a seeded row, and every seeded class is REACHABLE. Drives the REAL
// HostAuthProfileService (mirrors seed-scope-creation-parity running the real
// seed) against the seed rows + a permissive tenant read. Fails naming any gap.

// Any slug resolves to an active tenant so the TENANT class is reachable.
const permissiveTenants = {
  findActiveBySlug: async (): Promise<{ identity_provider: string | null }> => ({
    identity_provider: null,
  }),
} as unknown as TenantService;

// One representative host per seeded class (from the default posture).
const HOST_FOR_CLASS: Readonly<Record<HostClass, string>> = {
  PLATFORM: DEFAULT_PLATFORM_HOST,
  PORTAL: DEFAULT_PORTAL_HOST,
  TENANT: 'astre.aramo.ai',
};

describe('Auth-Decoupling PR-1 §3.3 — resolver ≡ seed reachability', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      APP_ROOT_DOMAIN: process.env['APP_ROOT_DOMAIN'],
      AUTH_PLATFORM_HOSTS: process.env['AUTH_PLATFORM_HOSTS'],
      AUTH_PORTAL_HOSTS: process.env['AUTH_PORTAL_HOSTS'],
    };
    process.env['APP_ROOT_DOMAIN'] = 'aramo.ai';
    process.env['AUTH_PLATFORM_HOSTS'] = DEFAULT_PLATFORM_HOST;
    process.env['AUTH_PORTAL_HOSTS'] = DEFAULT_PORTAL_HOST;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const classifier = () =>
    new HostAuthProfileService(
      fakeStore({}) as never,
      new IdentityHostContextAdapter(permissiveTenants),
    );

  it('every seeded class is reachable by the classifier', async () => {
    const reached = new Set<HostClass>();
    for (const cls of HOST_CLASSES) {
      const hit = await classifier().resolve(HOST_FOR_CLASS[cls]);
      if (hit !== null) reached.add(hit.hostClass);
    }
    const gaps = HOST_CLASSES.filter((c) => !reached.has(c));
    expect(gaps).toEqual([]); // a seeded class the resolver can't reach = the §3.3 gap
    expect(reached).toEqual(new Set<HostClass>(HOST_CLASSES));
  });

  it('the classifier never produces a class outside the seeded vocab', async () => {
    for (const cls of HOST_CLASSES) {
      const hit = await classifier().resolve(HOST_FOR_CLASS[cls]);
      if (hit !== null) expect(HOST_CLASSES).toContain(hit.hostClass);
    }
  });
});
