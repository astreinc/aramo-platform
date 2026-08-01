import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REDACTION_REASON_CODES, redactedNoteLabel } from './redaction';

// Charter §4 Amendment §3 — the FE reason-code vocabulary hand-mirrors the BE
// closed set (apps/ats-web cannot import @aramo/activity — a forbidden domain
// edge). The BE file is the source of truth; this reads it as text and asserts
// the FE mirror is IDENTICAL, order included. Any add/remove/rename in the BE
// fails here, forcing the FE mirror to update in lock-step. (Same drift-guard
// pattern as task-vocab-drift.spec.ts.)
const BE = resolve(
  __dirname,
  '../../../../libs/activity/src/lib/dto/redaction-reason.ts',
);

function beCodes(): string[] {
  const source = readFileSync(BE, 'utf8');
  const marker = 'export const REDACTION_REASON_CODES = [';
  const start = source.indexOf(marker);
  if (start === -1) throw new Error('drift: BE REDACTION_REASON_CODES not found');
  const open = start + marker.length - 1;
  const close = source.indexOf(']', open);
  return [...source.slice(open + 1, close).matchAll(/'([^']+)'/g)].map(
    (m) => m[1] as string,
  );
}

describe('redaction reason codes — FE mirror is identical to the BE closed set', () => {
  it('REDACTION_REASON_CODES matches libs/activity redaction-reason.ts (order included)', () => {
    expect([...REDACTION_REASON_CODES]).toEqual(beCodes());
  });
});

describe('redactedNoteLabel — attribution + date only (§8: never the reason)', () => {
  it('renders "Note removed by {name} on {date}"', () => {
    expect(redactedNoteLabel('2026-08-01T09:00:00.000Z', 'Dana Lee')).toBe(
      'Note removed by Dana Lee on 2026-08-01',
    );
  });

  it('falls back to a generic actor when the name is unresolved', () => {
    expect(redactedNoteLabel('2026-08-01T09:00:00.000Z', null)).toBe(
      'Note removed by a user on 2026-08-01',
    );
  });
});
