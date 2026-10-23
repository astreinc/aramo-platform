import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_EVIDENCE_THRESHOLDS, ROLE_FAMILIES, parseEvidenceThresholds } from '@aramo/matching';
import { describe, expect, it } from 'vitest';

// ATI-SEP-1 A2 A-c (P1) — the MatchingPolicy store's seeded version 1 equals the
// compiled engine defaults, which equal the pre-policy §2.5 constants: behaviour is
// unchanged by moving the thresholds into the platform-owned store. Reads the seed
// document straight out of the migration SQL (no DB), so a drift on either side
// fails here.

const MIGRATION = resolve(
  __dirname,
  '../../../../libs/skills-taxonomy/prisma/migrations/20261023140000_matching_policy/migration.sql',
);

// The table engine.ts hard-coded before P1 (frozen literal).
const PRE_POLICY_CONSTANTS = {
  backend_engineer: { count: 2, requires_ingested: true },
  frontend_engineer: { count: 2, requires_ingested: true },
  fullstack_engineer: { count: 2, requires_ingested: true },
  devops_sre: { count: 2, requires_ingested: true },
  data_engineer: { count: 2, requires_ingested: true },
  architect: { count: 3, requires_ingested: true },
  qa_test_engineer: { count: 2, requires_ingested: true },
  product_project_manager: { count: 2, requires_ingested: false },
  business_analyst: { count: 2, requires_ingested: false },
};

function seededThresholds(): unknown {
  const sql = readFileSync(MIGRATION, 'utf8');
  const seed = sql.slice(sql.indexOf('-- matching-policy-v1-thresholds'));
  const m = /'(\{"backend_engineer".*?\})'::jsonb/.exec(seed);
  if (m === null || m[1] === undefined) throw new Error('seed thresholds literal not found in migration');
  return JSON.parse(m[1]);
}

describe('MatchingPolicy v1 seed', () => {
  it('equals the compiled defaults and the pre-policy constants exactly', () => {
    const seeded = seededThresholds();
    expect(seeded).toEqual(PRE_POLICY_CONSTANTS);
    expect(seeded).toEqual(DEFAULT_EVIDENCE_THRESHOLDS);
  });

  it('passes the strict libs/matching parser (the engine can read it)', () => {
    const r = parseEvidenceThresholds(seededThresholds());
    expect(r.ok).toBe(true);
  });

  it('lists the role families in ROLE_FAMILIES order', () => {
    expect(Object.keys(seededThresholds() as object)).toEqual([...ROLE_FAMILIES]);
  });

  it('seeds version 1 as the ACTIVE version', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const seed = sql.slice(sql.indexOf('-- matching-policy-v1-thresholds'));
    expect(seed).toMatch(/'019a0000-0000-7000-8000-00000000a001',\s*1,\s*'ACTIVE'/);
  });
});
