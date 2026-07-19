import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLATFORM_HOST,
  DEFAULT_PORTAL_HOST,
  HOST_CLASSES,
  SEED_POOL_ID,
  buildHostAuthProfileSeedRows,
  seedHostAuthProfiles,
  type HostClass,
  type HostAuthProfileSeedClient,
} from '../lib/host-auth-profile.seed.js';

// Auth-Decoupling PR-1 §3.3 — SEED PARITY GUARD (UNIT spec). Programmatic, never
// hand-listed (mirrors seed-scope-creation-parity / F-P4b-1): every host_class
// in the closed vocab has a seeded row, and the seed produces exactly the vocab.
// A UNIT spec on purpose — libs/auth-storage integration specs are gated by
// ARAMO_RUN_INTEGRATION, the same class of gap that let D-SEED-SCOPES-1 reach the
// box; this guard runs in the always-on unit lane.

// A minimal env so the builder is deterministic regardless of the runner's env.
const ENV = {
  APP_ROOT_DOMAIN: 'aramo.ai',
  AUTH_PLATFORM_HOSTS: DEFAULT_PLATFORM_HOST,
  AUTH_PORTAL_HOSTS: DEFAULT_PORTAL_HOST,
} as const;

describe('Auth-Decoupling PR-1 §3.3 — host-auth-profile seed parity', () => {
  it('every host_class in the closed vocab has exactly one seeded row', () => {
    const rows = buildHostAuthProfileSeedRows(ENV);
    const seededClasses = rows.map((r) => r.host_class);
    const missing = HOST_CLASSES.filter((c) => !seededClasses.includes(c));
    expect(missing).toEqual([]); // a vocab class with no seed row = the gap §3.3 guards
    // one row per class — no dup, no extra class outside the vocab
    expect(new Set(seededClasses)).toEqual(new Set<HostClass>(HOST_CLASSES));
    expect(seededClasses.length).toBe(HOST_CLASSES.length);
  });

  it('no seeded row carries a class outside the closed vocab', () => {
    const rows = buildHostAuthProfileSeedRows(ENV);
    const extra = rows.map((r) => r.host_class).filter((c) => !HOST_CLASSES.includes(c));
    expect(extra).toEqual([]);
  });

  it('every row seeds the single reused pool (R-A1-5) — no multi-pool', () => {
    for (const row of buildHostAuthProfileSeedRows(ENV)) {
      expect(row.pool_id).toBe(SEED_POOL_ID);
    }
  });

  it('every row has default_idp null (PLATFORM/PORTAL no hint; TENANT overridden)', () => {
    for (const row of buildHostAuthProfileSeedRows(ENV)) {
      expect(row.default_idp).toBeNull();
    }
  });

  it('the default posture reproduces today’s hosts', () => {
    const byClass = new Map(buildHostAuthProfileSeedRows({}).map((r) => [r.host_class, r]));
    expect(byClass.get('PLATFORM')?.host_pattern).toBe(DEFAULT_PLATFORM_HOST);
    expect(byClass.get('PORTAL')?.host_pattern).toBe(DEFAULT_PORTAL_HOST);
    expect(byClass.get('TENANT')?.host_pattern).toBe('*.aramo.ai');
  });

  it('seedHostAuthProfiles upserts one row per class, keyed on host_class', async () => {
    const upserts: Array<{ where: { host_class: string } }> = [];
    const client: HostAuthProfileSeedClient = {
      hostAuthProfile: {
        upsert: async (args) => {
          upserts.push(args);
          return {};
        },
      },
    };
    const { seeded } = await seedHostAuthProfiles(client, ENV);
    expect(new Set(seeded)).toEqual(new Set<HostClass>(HOST_CLASSES));
    expect(upserts.map((u) => u.where.host_class).sort()).toEqual(
      [...HOST_CLASSES].sort(),
    );
  });
});
