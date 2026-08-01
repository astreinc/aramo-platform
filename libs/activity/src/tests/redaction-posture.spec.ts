import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Charter §4 Amendment §6 — the posture-shift assertions. activity.Activity
// moved from create-only to create + ONE controlled redact-update. These are
// the PR's real deliverable: they assert the mutation surface stays minimal.
//
// The repository is read as source and scanned for Prisma mutation calls. The
// honest framing (per the premise-guard): there is exactly one Prisma update
// (inside redact()); no updateMany / upsert / delete anywhere; and the ONLY
// other write is the pre-existing `repointTalentRecordRefs`, a raw-SQL
// subject_id repoint for TR-2a identity merge — not a Prisma update surface.
const REPO = readFileSync(
  resolve(__dirname, '../lib/activity.repository.ts'),
  'utf8',
);

function count(needle: string): number {
  return REPO.split(needle).length - 1;
}

describe('activity repository — redaction posture (§6)', () => {
  it('has NO delete / deleteMany / upsert / updateMany Prisma surface', () => {
    expect(count('.delete(')).toBe(0);
    expect(count('.deleteMany(')).toBe(0);
    expect(count('.upsert(')).toBe(0);
    expect(count('.updateMany(')).toBe(0);
  });

  it('has exactly ONE Prisma update — inside redact()', () => {
    expect(count('.update(')).toBe(1);
    const redactStart = REPO.indexOf('async redact(');
    const nextMethod = REPO.indexOf('async ', redactStart + 1);
    const redactBody = REPO.slice(redactStart, nextMethod);
    expect(redactBody).toContain('.update(');
  });

  it('exposes exactly one redaction writer named redact() and no un-redact', () => {
    expect(count('async redact(')).toBe(1);
    expect(REPO).not.toContain('unredact');
    expect(REPO).not.toContain('unRedact');
  });

  it('redact writes ONLY the four redaction columns + clears notes (explicit data object)', () => {
    // Isolate the `data: { ... }` object of the single update call.
    const updateIdx = REPO.indexOf('.update(');
    const dataIdx = REPO.indexOf('data: {', updateIdx);
    const dataClose = REPO.indexOf('},', dataIdx);
    const dataObj = REPO.slice(dataIdx, dataClose);
    expect(dataObj).toContain('notes: null');
    expect(dataObj).toContain('redacted_at:');
    expect(dataObj).toContain('redacted_by:');
    expect(dataObj).toContain('redaction_reason_code:');
    expect(dataObj).toContain('redaction_reason:');
    // No other column is written by the redaction update.
    for (const col of [
      'subject_id',
      'subject_type',
      'created_by_id',
      'created_at',
      'tenant_id',
      'site_id',
      'type:',
    ]) {
      expect(dataObj).not.toContain(col);
    }
  });

  it('the pre-existing repoint remains a raw-SQL subject_id write (named exception, not a Prisma update)', () => {
    expect(REPO).toContain('repointTalentRecordRefs');
    expect(REPO).toContain('$queryRawUnsafe');
  });
});
