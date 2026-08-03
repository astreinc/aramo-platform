import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUISITION_STATUS_VALUES } from './types';

// T1-d Q7 — the RecruitingStatus mirror drift guard.
//
// apps/ats-web cannot import @aramo/requisition (a forbidden domain edge), so
// REQUISITION_STATUS_VALUES in ./types is a HAND-MIRROR of the Prisma enum
// `RecruitingStatus`. This spec makes the mirror a SOURCE OF TRUTH, not a copy:
// it reads the BE schema as text, regex-extracts the enum members, and asserts
// the FE tuple equals the BE enum — same members, SAME ORDER. If the BE enum
// changes and this mirror is not updated in lockstep, the build fails here.
//
// Pattern mirrors apps/ats-web/src/pipeline/legal-transitions-drift.spec — read
// the BE source as text (never import it) and structurally compare.

const REPO_ROOT = resolve(__dirname, '../../../..');
const SCHEMA_PATH = resolve(
  REPO_ROOT,
  'libs/requisition/prisma/schema.prisma',
);

function beEnumValues(): string[] {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const match = schema.match(/enum RecruitingStatus \{([^}]*)\}/);
  if (match === null) {
    throw new Error('RecruitingStatus enum not found in the Prisma schema');
  }
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    // Drop blank lines, the @@schema attribute, and any comment lines.
    .filter((line) => line.length > 0 && !line.startsWith('@@') && !line.startsWith('//'));
}

describe('RecruitingStatus FE mirror drift guard (T1-d Q7)', () => {
  it('the FE mirror equals the BE Prisma enum — same members, same order', () => {
    const be = beEnumValues();
    expect([...REQUISITION_STATUS_VALUES]).toEqual(be);
  });

  it('carries the T1-d value set (retained lead + inert draft/pending_approval/archived)', () => {
    const values = new Set<string>(REQUISITION_STATUS_VALUES);
    // Retained / renamed live states.
    for (const v of ['lead', 'open', 'on_hold', 'submittals_closed', 'closed', 'canceled']) {
      expect(values.has(v), v).toBe(true);
    }
    // Present-but-inert states.
    for (const v of ['draft', 'pending_approval', 'archived']) {
      expect(values.has(v), v).toBe(true);
    }
    // The superseded values must be gone.
    expect(values.has('active')).toBe(false);
    expect(values.has('full')).toBe(false);
  });
});
