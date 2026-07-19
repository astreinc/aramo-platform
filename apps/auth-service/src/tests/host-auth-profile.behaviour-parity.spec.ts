import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSUMER_TYPES } from '@aramo/auth';
import { DEFAULT_PLATFORM_HOST, DEFAULT_PORTAL_HOST } from '@aramo/auth-storage';

import { deriveRedirectUri } from '../app/auth/redirect-uri.js';

import {
  fakeTenantService,
  resolverLegacy,
  resolverWithRegistry,
} from './host-auth-profile.test-fixtures.js';

// Auth-Decoupling PR-1 §3.1 — BEHAVIOUR-PRESERVATION is the acceptance bar
// (R-A1-1). For each of the 4 consumer slugs × each host class, the resolved
// { derivedBase, identityProvider } AND the derived redirect
// (`${base}/auth/${consumer}/callback`) must be IDENTICAL before and after the
// re-point. The oracle: HostBaseResolver with an EMPTY registry (falls through
// to the pre-PR-1 legacy path = "before") vs a SEEDED registry (the new registry
// path = "after"). Same fake tenant read for both.

const ENV_KEYS = [
  'AUTH_PLATFORM_HOSTS',
  'AUTH_PORTAL_HOSTS',
  'APP_ROOT_DOMAIN',
  'NODE_ENV',
  'AUTH_ALLOW_INSECURE_COOKIES',
  'AUTH_PUBLIC_BASE_URL',
  'AUTH_COGNITO_REDIRECT_URI',
] as const;

// The four consumer slugs (closed enum) — every login surface.
const CONSUMERS = CONSUMER_TYPES;

// One representative host per class + the fall-through cases the legacy path
// owns (dev, hostile, non-existent tenant). `expectBase`/`expectIdp` also guard
// against BOTH paths being equally broken.
const HOSTS: ReadonlyArray<{
  readonly label: string;
  readonly host: string;
  readonly expectBase: string | null;
  readonly expectIdp: string | null;
}> = [
  { label: 'PLATFORM', host: DEFAULT_PLATFORM_HOST, expectBase: `https://${DEFAULT_PLATFORM_HOST}`, expectIdp: null },
  { label: 'PORTAL', host: DEFAULT_PORTAL_HOST, expectBase: `https://${DEFAULT_PORTAL_HOST}`, expectIdp: null },
  { label: 'TENANT (idp set)', host: 'astre.aramo.ai', expectBase: 'https://astre.aramo.ai', expectIdp: 'AstreSAML' },
  { label: 'TENANT (idp null)', host: 'noidp.aramo.ai', expectBase: 'https://noidp.aramo.ai', expectIdp: null },
  { label: 'TENANT-shaped, no active tenant', host: 'ghost.aramo.ai', expectBase: null, expectIdp: null },
  { label: 'hostile host', host: 'evil.com', expectBase: null, expectIdp: null },
  { label: 'dev localhost', host: 'localhost', expectBase: 'http://localhost', expectIdp: null },
  { label: 'dev 127.0.0.1', host: '127.0.0.1', expectBase: 'http://127.0.0.1', expectIdp: null },
];

describe('Auth-Decoupling PR-1 §3.1 — host auth-profile behaviour preservation', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env['AUTH_PLATFORM_HOSTS'] = DEFAULT_PLATFORM_HOST;
    process.env['AUTH_PORTAL_HOSTS'] = DEFAULT_PORTAL_HOST;
    process.env['APP_ROOT_DOMAIN'] = 'aramo.ai';
    // Dev posture (for the localhost cases): non-prod + insecure cookies.
    process.env['NODE_ENV'] = 'test';
    process.env['AUTH_ALLOW_INSECURE_COOKIES'] = 'true';
    // No AUTH_PUBLIC_BASE_URL / legacy redirect — unvalidated hosts resolve to
    // a null base identically on both paths.
    delete process.env['AUTH_PUBLIC_BASE_URL'];
    delete process.env['AUTH_COGNITO_REDIRECT_URI'];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const tenants = () =>
    fakeTenantService({
      astre: { identity_provider: 'AstreSAML' },
      noidp: { identity_provider: null },
    });

  for (const { label, host, expectBase, expectIdp } of HOSTS) {
    it(`${label} (${host}) — resolved base + idp identical before/after`, async () => {
      const t = tenants();
      const before = await resolverLegacy(t).resolve(host);
      const after = await resolverWithRegistry(t).resolve(host);

      // Anchor: the expected pre-PR-1 behaviour (guards against both-broken).
      expect(before).toEqual({ derivedBase: expectBase, identityProvider: expectIdp });
      // The acceptance bar: registry path is byte-identical.
      expect(after).toEqual(before);
    });

    it(`${label} (${host}) — derived redirect identical for all 4 consumers`, async () => {
      const t = tenants();
      const before = await resolverLegacy(t).resolve(host);
      const after = await resolverWithRegistry(t).resolve(host);
      for (const consumer of CONSUMERS) {
        expect(deriveRedirectUri(consumer, after.derivedBase)).toBe(
          deriveRedirectUri(consumer, before.derivedBase),
        );
      }
    });
  }
});
