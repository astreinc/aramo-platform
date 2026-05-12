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

describe('seed role catalog (§6 closed set)', () => {
  it('seed role keys are exactly the three locked entries', () => {
    expect([...SEED_ROLE_KEYS].sort()).toEqual(['recruiter', 'tenant_admin', 'viewer']);
  });
});
