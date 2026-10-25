import { describe, expect, it } from 'vitest';

import {
  SEED_IDS,
  SEED_COGNITO_SUB,
  SEED_TENANT_NAME,
  SEED_ADMIN_EMAIL,
  SEED_SERVICE_ACCOUNT_NAME,
} from '../../prisma/seed.js';
import { SCOPE_KEY_FORMAT, SEED_SCOPE_KEYS, SEED_ROLE_KEYS } from '../lib/dto/index.js';

// Unit-level seed tests: catalog correctness, scope key format, hardcoded ID
// determinism (every UUID is a fixed string; not random). The full
// "run seed twice" determinism (tests 10 + 11) is exercised by the
// integration suite (identity.integration.spec.ts) against real Postgres.

describe('seed determinism — hardcoded UUIDs (tests 10/11 supporting, unit tier)', () => {
  it('all SEED_IDS values are valid UUIDs (deterministic, hardcoded constants)', () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    function walk(node: unknown, path: string[]): void {
      if (typeof node === 'string') {
        expect(node, `SEED_IDS at ${path.join('.')}`).toMatch(UUID);
      } else if (node !== null && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          walk(v, [...path, k]);
        }
      }
    }
    walk(SEED_IDS, []);
  });

  it('SEED_COGNITO_SUB is a stable fixed value', () => {
    expect(SEED_COGNITO_SUB).toBe('fixed-dev-cognito-sub-01');
  });

  it('SEED constants match directive §8 prose verbatim', () => {
    expect(SEED_TENANT_NAME).toBe('Aramo Dev Tenant');
    expect(SEED_ADMIN_EMAIL).toBe('admin@aramo.dev');
    expect(SEED_SERVICE_ACCOUNT_NAME).toBe('system-bootstrap');
  });
});

// Test 18: Scope key format validation. All seeded Scope keys match the
// <domain>:<action> regex per §9 test 18.
describe('seed scope catalog — key format (test 18)', () => {
  it('all six seed scope keys match SCOPE_KEY_FORMAT regex', () => {
    for (const key of SEED_SCOPE_KEYS) {
      expect(key, `scope key ${key}`).toMatch(SCOPE_KEY_FORMAT);
    }
  });

  it('SCOPE_KEY_FORMAT rejects malformed keys (defensive)', () => {
    const negatives = [
      '', // empty
      'CONSENT:read', // uppercase domain
      ':read', // empty domain
      'consent:', // empty action
      '1consent:read', // digit-led domain
      'consent read', // space
    ];
    for (const bad of negatives) {
      expect(SCOPE_KEY_FORMAT.test(bad), `should reject "${bad}"`).toBe(false);
    }
  });
});

describe('seed role catalog (§6 closed set, PR-A1a expansion, AUTHZ-1 + AUTHZ-1b + AUTHZ-2)', () => {
  it('seed role keys are exactly the 14 locked entries (13 tenant + 1 platform)', () => {
    // AUTHZ-1 (2026-06-04): tenant role catalog expanded 4 -> 13.
    // AUTHZ-1b (2026-06-04): revised to the 12 staffing-tenant roles
    // (retire viewer/hiring_manager/interviewer/coordinator/external_agency;
    // add recruiting_manager/delivery_manager/lead_recruiter/back_office;
    // rename finance_hr -> finance; preserve candidate).
    // AUTHZ-2 (2026-06-04): adds the PLATFORM-TIER super_admin role
    // (catalog row 13). The 12 tenant role keys hold ONLY tenant scopes;
    // the platform super_admin row holds ONLY platform:* scopes. The
    // namespace partition + the consumer_type check at the guard layer
    // is the DDR §13.1 tripwire (a platform token never satisfies a
    // tenant guard, and vice versa).
    // Settings S4 (2026-06-05): adds the tenant-tier
    // `auditor_with_financials` role (12 -> 13 tenant; 14 total). The
    // role's GRANT is gated by the audit.financials_enabled KNOWN_SETTING
    // at the role-assign path; the SEED of the role itself is
    // unconditional (the GATE is keyed at the membership-write boundary,
    // NOT at the role-existence boundary).
    // ROLES-1 PR-2 (§1) — row 0010 is ats_admin (formerly tenant_admin); row 02b0 is
    // tenant_admin (formerly org_admin). org_admin no longer exists. ROLES-1 PR-3: the
    // retired sign_owner is not a catalog key (RETIRED_ROLE_KEYS; its row stays inactive).
    // CCP A1 +6 roles / +15 scopes / +45 grants → 25 / 205 / 984: the 6 platform-tier commercial roles (18 → 24 keys).
    expect([...SEED_ROLE_KEYS].sort()).toEqual([
      'account_manager',
      'ats_admin',
      'auditor',
      'auditor_with_financials',
      'back_office',
      'candidate',
      'catalog_manager', // CCP A1
      'commercial_ops', // CCP A1
      'delivery_manager',
      'finance',
      'finance_admin', // CCP A1
      'lead_recruiter',
      'platform_owner', // CCP A1
      'read_only_auditor', // CCP A1
      'recruiter',
      'recruiting_manager',
      // PX-V1 PX-3 — Sign product roles (namespace-separate from ATS tenant roles).
      'sign_admin',
      'sign_sender',
      'sign_viewer',
      'sourcer',
      'super_admin',
      'support_admin', // CCP A1
      'tenant_admin',
      'tenant_owner',
    ]);
  });
});

// IC-3 PR-8 — deterministic seed proof of the Sign sender authority: the
// `sign:envelope:send` scope is granted to EXACTLY sign_admin /
// sign_sender (ESIGN_SENDER_SEED_BUNDLES); sign_viewer never holds it, and no
// other seed bundle (ATS roles, org_admin, super_admin) grants ANY esign:* scope.
describe('IC-3 PR-8 — Sign sender authority is seeded deterministically', () => {
  it('sign:envelope:send is granted to exactly the three sender roles; sign_viewer is read-only', async () => {
    const { ESIGN_SENDER_SEED_BUNDLES, SEED_IDS } = await import('../../prisma/seed.js');
    const { ESIGN_PRODUCT_ROLE_KEYS, ESIGN_SENDER_SCOPE_KEY } = await import('../lib/dto/role.dto.js');
    const holders = ESIGN_SENDER_SEED_BUNDLES.filter(([, scopes]) => scopes.includes(ESIGN_SENDER_SCOPE_KEY)).map(([k]) => k).sort();
    // ROLES-1 PR-3 — the retired sign_owner is granted nothing.
    expect(holders).toEqual(['sign_admin', 'sign_sender']);
    expect(ESIGN_SENDER_SEED_BUNDLES.find(([k]) => k === 'sign_viewer')?.[1]).toEqual(['sign:envelope:read']);
    // Every bundle key is a seeded Sign role with a deterministic role id, and the
    // partition constant covers exactly the bundle keys (no orphan role, no hand list drift).
    expect(ESIGN_SENDER_SEED_BUNDLES.map(([k]) => k).sort()).toEqual([...ESIGN_PRODUCT_ROLE_KEYS].sort());
    for (const k of ESIGN_PRODUCT_ROLE_KEYS) expect(SEED_IDS.roles[k as keyof typeof SEED_IDS.roles]).toMatch(/^01900000-0000-7000-8000-0000000002a[0-3]$/);
    // The Sign bundles hold ONLY esign:* scopes (never an ATS or platform scope).
    for (const [, scopes] of ESIGN_SENDER_SEED_BUNDLES) expect(scopes.every((s) => s.startsWith('sign:'))).toBe(true);
  });
});

// Sign Unified Product S-1 — the Sign permission contract is seeded exactly: the
// prior ESIGN_SENDER_SEED_BUNDLES grants plus ESIGN_ROLE_CONTRACT_SEED_BUNDLES
// equal ESIGN_ROLE_PERMISSIONS per role (no grant removed, none invented), every
// contract scope is in the catalog with a deterministic id, and no non-Sign role
// holds any esign:* scope.
describe('Sign S-1 — the Sign role contract is seeded exactly', () => {
  it('prior + contract grants = ESIGN_ROLE_PERMISSIONS for each of the three Sign roles', async () => {
    const { ESIGN_SENDER_SEED_BUNDLES, ESIGN_ROLE_CONTRACT_SEED_BUNDLES, SEED_IDS } = await import('../../prisma/seed.js');
    const { ESIGN_ROLE_KEYS, ESIGN_ROLE_PERMISSIONS } = await import('../lib/dto/esign-permissions.js');
    const { SEED_SCOPE_KEYS } = await import('../lib/dto/scope.dto.js');
    let contractGrants = 0;
    for (const role of ESIGN_ROLE_KEYS) {
      const prior = ESIGN_SENDER_SEED_BUNDLES.find(([k]) => k === role)?.[1] ?? [];
      const added = ESIGN_ROLE_CONTRACT_SEED_BUNDLES.find(([k]) => k === role)?.[1] ?? [];
      contractGrants += added.length;
      expect(added.filter((s) => prior.includes(s))).toEqual([]);
      expect([...prior, ...added].sort()).toEqual([...ESIGN_ROLE_PERMISSIONS[role]].sort());
      for (const s of added) {
        expect(SEED_SCOPE_KEYS).toContain(s);
        expect(SEED_IDS.scopes[s as keyof typeof SEED_IDS.scopes]).toMatch(/^01900000-0000-7000-8000-00000000141[0-3]$|^01900000-0000-7000-8000-00000000140[a-f]$/);
      }
    }
    // ROLES-1 PR-3 — 23 − sign_owner's 10 (retired: no longer granted) = 13.
    // DOC-TEMPLATE-LIB-1 T-5 — − sign_admin × sign:template:{use,manage} − sign_sender ×
    // sign:template:use (removed) → 13 − 3 = 10.
    expect(contractGrants).toBe(10);
  });
});

// ROLES-1 PR-3 (§1, §5.2 step 5, §8) — the retired sign_owner keeps its row (inactive,
// for history) but no bundle; the frozen id layouts keep every other Sign grant's
// deterministic RoleScope id unchanged (append-don't-renumber).
describe('ROLES-1 PR-3 — sign_owner retired in the seed', () => {
  it('no seed bundle names sign_owner; RETIRED_ROLE_KEYS is outside every catalog constant', async () => {
    const { ESIGN_SENDER_SEED_BUNDLES, ESIGN_ROLE_CONTRACT_SEED_BUNDLES } = await import('../../prisma/seed.js');
    const { RETIRED_ROLE_KEYS, TENANT_ASSIGNABLE_ROLE_KEYS, ESIGN_PRODUCT_ROLE_KEYS, ATS_PRODUCT_ROLE_KEYS, ORG_ROLE_KEYS } = await import('../lib/dto/role.dto.js');
    expect([...RETIRED_ROLE_KEYS]).toEqual(['sign_owner']);
    for (const [k] of [...ESIGN_SENDER_SEED_BUNDLES, ...ESIGN_ROLE_CONTRACT_SEED_BUNDLES]) expect(k).not.toBe('sign_owner');
    for (const list of [SEED_ROLE_KEYS, TENANT_ASSIGNABLE_ROLE_KEYS, ESIGN_PRODUCT_ROLE_KEYS, ATS_PRODUCT_ROLE_KEYS, ORG_ROLE_KEYS]) {
      expect(list as readonly string[]).not.toContain('sign_owner');
    }
  });
});
