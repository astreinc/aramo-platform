import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Charter §4 Amendment §6 — the mutation-posture assertions, updated for RN-1
// (Requisition Enterprise Notes) + RN-1-A1 (the ActivityNoteEvent lifecycle
// ledger). The repository is read as source and scanned for Prisma mutation
// calls. Post-RN-1 the controlled mutation surface is:
//   1. redact() — ONE `activity.update` (clears notes + writes the 4 redaction
//      columns) plus the transactional REDACTED event append.
//   2. setPinned() — ONE `activityNote.update` (pin-state columns) plus the
//      transactional PINNED/UNPINNED event append.
//   3. the pre-existing raw-SQL `repointTalentRecordRefs` (not a Prisma update).
// The ActivityNoteEvent ledger is APPEND-ONLY: the repo never updates or deletes
// an event row (DB-enforced by a trigger; app layer only appends).
const REPO = readFileSync(
  resolve(__dirname, '../lib/activity.repository.ts'),
  'utf8',
);

function count(needle: string): number {
  return REPO.split(needle).length - 1;
}

function methodBody(name: string): string {
  const start = REPO.indexOf(`async ${name}(`);
  if (start === -1) throw new Error(`method ${name} not found`);
  // Next CLASS method (2-space indent). NOT any `async ` — the transactional
  // `async (tx) =>` callback inside the body must not end the slice.
  const next = REPO.indexOf('\n  async ', start + `async ${name}(`.length);
  return REPO.slice(start, next === -1 ? REPO.length : next);
}

describe('activity repository — mutation posture (§6, RN-1)', () => {
  it('has NO delete / deleteMany / upsert / updateMany Prisma surface', () => {
    expect(count('.delete(')).toBe(0);
    expect(count('.deleteMany(')).toBe(0);
    expect(count('.upsert(')).toBe(0);
    expect(count('.updateMany(')).toBe(0);
  });

  it('has exactly TWO Prisma updates — redact (activity) + setPinned (note)', () => {
    expect(count('.update(')).toBe(2);
    expect(count('activity.update(')).toBe(1); // the redact clears-notes update
    expect(count('activityNote.update(')).toBe(1); // the pin-state update
    // redact() carries exactly one update; setPinned() carries exactly one.
    expect(methodBody('redact').split('.update(').length - 1).toBe(1);
    expect(methodBody('setPinned').split('.update(').length - 1).toBe(1);
  });

  it('the ActivityNoteEvent ledger is append-only in the repo (no update/delete of an event row)', () => {
    expect(REPO).not.toContain('activityNoteEvent.update(');
    expect(REPO).not.toContain('activityNoteEvent.delete(');
    expect(REPO).not.toContain('activityNoteEvent.updateMany(');
  });

  it('exposes exactly one redaction writer named redact() and no un-redact', () => {
    expect(count('async redact(')).toBe(1);
    expect(REPO).not.toContain('unredact');
    expect(REPO).not.toContain('unRedact');
  });

  it('redact writes ONLY the four redaction columns + clears notes (explicit data object)', () => {
    // Isolate the `data: { ... }` of the update INSIDE redact() (the event
    // append that follows has its own data object — scope to redact's update).
    const body = methodBody('redact');
    const updateIdx = body.indexOf('.update(');
    const dataIdx = body.indexOf('data: {', updateIdx);
    const dataClose = body.indexOf('},', dataIdx);
    const dataObj = body.slice(dataIdx, dataClose);
    expect(dataObj).toContain('notes: null');
    expect(dataObj).toContain('redacted_at:');
    expect(dataObj).toContain('redacted_by:');
    expect(dataObj).toContain('redaction_reason_code:');
    expect(dataObj).toContain('redaction_reason:');
    // No other Activity column is written by the redaction update.
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
