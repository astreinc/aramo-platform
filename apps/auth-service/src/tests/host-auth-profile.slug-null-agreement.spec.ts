import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractTenantSlugFromHost, type TenantService } from '@aramo/identity';
import { DEFAULT_PLATFORM_HOST, DEFAULT_PORTAL_HOST } from '@aramo/auth-storage';

import { HostAuthProfileService, fakeStore } from './host-auth-profile.test-fixtures.js';

// Auth-Decoupling PR-1 §3.4 — the registry classifier must AGREE with
// extractTenantSlugFromHost (tenant-slug.ts:122-139) on EVERY null case: an
// empty hostname, a host not ending in `.<rootDomain>`, the bare apex, and a
// multi-label host. A null slug ⇒ the classifier never returns a TENANT hit.
// Anchored to the same root domain the classifier reads (APP_ROOT_DOMAIN).

const ROOT = 'aramo.ai';

// A tenant read that would return an ACTIVE tenant for ANY slug — so a TENANT
// classification could ONLY come from the parser disagreeing (it must not).
const permissiveTenants = {
  findActiveBySlug: async (): Promise<{ identity_provider: string | null }> => ({
    identity_provider: null,
  }),
} as unknown as TenantService;

function classifier(): HostAuthProfileService {
  return new HostAuthProfileService(fakeStore({}) as never, permissiveTenants);
}

const NULL_CASES: ReadonlyArray<{ label: string; host: string }> = [
  { label: 'empty hostname', host: '' },
  { label: 'not ending in .rootDomain', host: 'evil.com' },
  { label: 'sibling-domain lookalike', host: 'astre.attacker.com' },
  { label: 'bare apex', host: 'aramo.ai' },
  { label: 'multi-label under apex', host: 'a.b.aramo.ai' },
];

describe('Auth-Decoupling PR-1 §3.4 — classifier ≡ extractTenantSlugFromHost null cases', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      APP_ROOT_DOMAIN: process.env['APP_ROOT_DOMAIN'],
      AUTH_PLATFORM_HOSTS: process.env['AUTH_PLATFORM_HOSTS'],
      AUTH_PORTAL_HOSTS: process.env['AUTH_PORTAL_HOSTS'],
    };
    process.env['APP_ROOT_DOMAIN'] = ROOT;
    process.env['AUTH_PLATFORM_HOSTS'] = DEFAULT_PLATFORM_HOST;
    process.env['AUTH_PORTAL_HOSTS'] = DEFAULT_PORTAL_HOST;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  for (const { label, host } of NULL_CASES) {
    it(`${label} (${JSON.stringify(host)}) — parser null ⇒ no TENANT hit`, async () => {
      // The parser returns null for this host.
      expect(extractTenantSlugFromHost(host, ROOT)).toBeNull();
      // The classifier agrees: no TENANT classification (a miss, since these
      // hosts are neither PLATFORM nor PORTAL).
      const hit = await classifier().resolve(host);
      expect(hit?.hostClass).not.toBe('TENANT');
      expect(hit).toBeNull();
    });
  }

  it('positive agreement — a valid single-label host DOES classify TENANT', async () => {
    // The parser yields a slug; with an active tenant the classifier returns
    // TENANT — confirming the null-case refusals are specific, not blanket.
    expect(extractTenantSlugFromHost('astre.aramo.ai', ROOT)).toBe('astre');
    const hit = await classifier().resolve('astre.aramo.ai');
    expect(hit?.hostClass).toBe('TENANT');
    expect(hit?.derivedBase).toBe('https://astre.aramo.ai');
  });
});
