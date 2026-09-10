import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// TM-L1-C1 — structural negative boundary, scoped HONESTLY to the NEW canonical
// manual-capture path only. It does NOT claim the repository as a whole has no
// direct create: the legacy POST /v1/talent-records direct-create still exists
// until its TM-L1-E cutover. This proves ONLY that the C1 orchestration itself
// never mints a TalentRecord and never promotes — its output is a pre-Talent
// subject (Arrival != Talent).

const MANUAL_CAPTURE_DIR = resolve(__dirname, '../manual-capture');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const CODE = [
  'manual-capture.service.ts',
  'manual-capture.constants.ts',
]
  .map((f) => stripComments(readFileSync(resolve(MANUAL_CAPTURE_DIR, f), 'utf8')))
  .join('\n');

describe('TM-L1-C1 — the manual-capture path mints no Talent and never promotes', () => {
  it('takes no import edge on talent-record / promotion / trust', () => {
    for (const forbidden of [
      '@aramo/talent-record',
      '@aramo/talent-trust',
      './talent-identity/promotion',
      'promotion.service',
    ]) {
      expect(CODE.includes(`'${forbidden}'`) || CODE.includes(`"${forbidden}"`)).toBe(false);
    }
  });

  it('never calls a TalentRecord create or PromotionService.promoteSubject', () => {
    for (const forbidden of [
      'talentRecord.create',
      'TalentRecordRepository',
      'createForImport',
      'promoteSubject',
      'PromotionService',
    ]) {
      expect(CODE.includes(forbidden), `manual-capture must not reference ${forbidden}`).toBe(false);
    }
  });

  it('only orchestrates the governed staging collaborators (object-storage, ingestion, sourced-talent, common)', () => {
    const importRe = /from\s+['"](@aramo\/[^'"]+)['"]/g;
    const allowed = new Set([
      '@aramo/object-storage',
      '@aramo/ingestion',
      '@aramo/sourced-talent',
      '@aramo/common',
    ]);
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(CODE)) !== null) {
      expect(allowed.has(m[1]!), `unexpected cross-lib edge ${m[1]}`).toBe(true);
    }
  });
});
