import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  CAPABILITY_VALUES,
  DEFAULT_TENANT_CAPABILITIES,
  isCapability,
} from '../lib/capability.js';

// T2-E1-HF2 tests A/B/J — the canonical default tenant capability bundle is the
// single authoritative source and is exactly {core, ats, portal} with sourcing
// excluded.
describe('DEFAULT_TENANT_CAPABILITIES — canonical default bundle', () => {
  it('is exactly [core, ats, portal] (order-independent)', () => {
    expect([...DEFAULT_TENANT_CAPABILITIES].sort()).toEqual(
      ['ats', 'core', 'portal'].sort(),
    );
    expect(DEFAULT_TENANT_CAPABILITIES).toHaveLength(3);
  });

  it('excludes sourcing', () => {
    expect(DEFAULT_TENANT_CAPABILITIES).not.toContain('sourcing');
  });

  // ATI-SEP-1 T9 — Talent Intelligence is a catalog capability, default OFF.
  it('catalogs `intelligence` but never grants it by default', () => {
    expect(CAPABILITY_VALUES).toContain('intelligence');
    expect(isCapability('intelligence')).toBe(true);
    expect(DEFAULT_TENANT_CAPABILITIES).not.toContain('intelligence');
  });

  it('the enum migration adds `intelligence` idempotently and grants no tenant', () => {
    const sql = readFileSync(
      resolve(__dirname, '../../prisma/migrations/20261024150000_add_intelligence_capability/migration.sql'),
      'utf8',
    );
    const statements = sql.split('\n').filter((l) => l.trim().length > 0 && !l.trim().startsWith('--'));
    expect(statements).toEqual([`ALTER TYPE "entitlement"."Capability" ADD VALUE IF NOT EXISTS 'intelligence';`]);
    expect(statements.join(" ")).not.toMatch(/INSERT|TenantEntitlement/);
  });

  it('contains only valid capability keys that are a subset of the catalog', () => {
    for (const c of DEFAULT_TENANT_CAPABILITIES) {
      expect(isCapability(c)).toBe(true);
      expect(CAPABILITY_VALUES).toContain(c);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(DEFAULT_TENANT_CAPABILITIES).size).toBe(
      DEFAULT_TENANT_CAPABILITIES.length,
    );
  });
});
