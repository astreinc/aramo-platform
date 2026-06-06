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
    expect([...SEED_ROLE_KEYS].sort()).toEqual([
      'account_manager',
      'auditor',
      'auditor_with_financials',
      'back_office',
      'candidate',
      'delivery_manager',
      'finance',
      'lead_recruiter',
      'recruiter',
      'recruiting_manager',
      'sourcer',
      'super_admin',
      'tenant_admin',
      'tenant_owner',
    ]);
  });
});
