import { describe, expect, it } from 'vitest';

import { REPEAT_MAX, cloneFields, nextGroupKey, repeatCountOf, repeatDown, repeatPitchOf, repeatPitchOfText, type CloneContext } from './clone';
import { DEFAULT_SETTINGS, type PlacedField } from './model';

// FIELD-PARITY-1 §5 P2-1 — building duplicates, pasted copies and Repeat down rows.

const LETTER = { width: 612, height: 792 };
const SMALL = { width: 300, height: 400 };
const field = (id: string, over: Partial<PlacedField> = {}): PlacedField => ({
  id,
  type: 'TEXT',
  docId: 'd1',
  page: 0,
  x: 100,
  y: 500,
  width: 230,
  height: 22,
  required: true,
  assignee: 's1',
  binding: null,
  settings: DEFAULT_SETTINGS,
  ...over,
});

// The console's id rule: <type>_<n>, the next free n given every field so far.
const consoleId = (type: string, fields: readonly PlacedField[]): string => {
  const taken = new Set(fields.map((f) => f.id));
  let i = 1;
  while (taken.has(`${type.toLowerCase()}_${i}`)) i += 1;
  return `${type.toLowerCase()}_${i}`;
};
const ctx = (precision: CloneContext['precision'] = 'hundredths'): CloneContext => ({
  precision,
  pageSize: (ref) => (ref.docId === 'small' ? SMALL : LETTER),
  newId: consoleId,
});

describe('cloneFields (duplicate / paste)', () => {
  it('keeps type, size, assignee, required and settings; new ids run on; moved right and down', () => {
    const cb = field('checkbox_1', { type: 'CHECKBOX', width: 18, height: 18, settings: { ...DEFAULT_SETTINGS, label: 'Yes', groupKey: 'g' } });
    const all = [field('text_1'), cb];
    const out = cloneFields(all, all, { dx: 10, dy: 10 }, ctx());
    expect(out.map((f) => f.id)).toEqual(['text_2', 'checkbox_2']);
    expect(out[0]).toMatchObject({ type: 'TEXT', x: 110, y: 490, width: 230, height: 22, required: true, assignee: 's1' });
    // A duplicated check box stays in its group, with its label.
    expect(out[1]!.settings).toEqual({ ...DEFAULT_SETTINGS, label: 'Yes', groupKey: 'g' });
  });

  it('never copies a locked or hidden field', () => {
    const all = [field('a', { locked: true }), field('b', { hidden: true }), field('c')];
    expect(cloneFields(all, all, { dx: 0, dy: 0 }, ctx()).map((f) => f.type)).toEqual(['TEXT']);
  });

  it('pastes onto another page at the same position, clamped to a smaller page', () => {
    const out = cloneFields([field('text_1')], [field('text_1')], { dx: 0, dy: 0, target: { docId: 'd1', page: 2 } }, ctx());
    expect(out[0]).toMatchObject({ page: 2, x: 100, y: 500 });
    const small = cloneFields([field('text_1')], [field('text_1')], { dx: 0, dy: 0, target: { docId: 'small', page: 0 } }, ctx());
    // Top-left on Letter: (100, 270). On a 300×400 page the 230-wide box fits from x = 70; y stays 270 from the top.
    expect(small[0]).toMatchObject({ docId: 'small', x: 70, y: 400 - 270 - 22 });
  });

  it('rounds by the host rule (integer: whole points in the top-left frame)', () => {
    const f = field('a', { x: 100.4, y: 500.3 });
    const out = cloneFields([f], [f], { dx: 10, dy: 10 }, ctx('integer'));
    expect(Number.isInteger(out[0]!.x)).toBe(true);
    expect(Number.isInteger(out[0]!.y)).toBe(true);
  });
});

describe('repeatDown', () => {
  const row = [field('text_1', { x: 72, y: 600 }), field('checkbox_1', { type: 'CHECKBOX', x: 320, y: 602, width: 18, height: 18, settings: { ...DEFAULT_SETTINGS, groupKey: 'attend', groupRule: 'SELECT_ONE' } })];

  it('adds N rows at the set distance, top to top, with every group copied per row', () => {
    const r = repeatDown(row, row, { count: 3, pitch: 30 }, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ rows: 3, skipped: 0 });
    expect(r.fields).toHaveLength(6);
    expect(r.fields.filter((f) => f.type === 'TEXT').map((f) => f.y)).toEqual([570, 540, 510]);
    expect(r.fields.filter((f) => f.type === 'TEXT').map((f) => f.id)).toEqual(['text_2', 'text_3', 'text_4']);
    // Each new row's check box gets its own group (rule kept).
    expect(r.fields.filter((f) => f.type === 'CHECKBOX').map((f) => f.settings.groupKey)).toEqual(['attend_2', 'attend_3', 'attend_4']);
    expect(r.fields.every((f) => f.type !== 'CHECKBOX' || f.settings.groupRule === 'SELECT_ONE')).toBe(true);
  });

  it('skips rows that would run off the page and reports them', () => {
    const low = [field('t', { y: 60 })];
    const r = repeatDown(low, low, { count: 9, pitch: 30 }, ctx());
    expect(r).toMatchObject({ ok: true, rows: 2, skipped: 7 });
  });

  it('caps the count, and refuses rows on several pages or nothing copyable', () => {
    const r = repeatDown([field('t', { y: 780, height: 10 })], [field('t', { y: 780, height: 10 })], { count: 500, pitch: 1 }, ctx());
    expect(r.ok && r.rows).toBe(REPEAT_MAX);
    expect(repeatDown([], [field('a'), field('b', { page: 1 })], { count: 2, pitch: 30 }, ctx())).toEqual({ ok: false, reason: 'pages' });
    expect(repeatDown([], [field('a', { locked: true })], { count: 2, pitch: 30 }, ctx())).toEqual({ ok: false, reason: 'nothing' });
  });

  it('the suggested distance is the row height plus a 6pt gap', () => {
    expect(repeatPitchOf(row, ctx().pageSize)).toBe(22 + 6);
    expect(repeatPitchOf([field('a'), field('b', { page: 1 })], ctx().pageSize)).toBeNull();
  });

  it('group keys: the next free suffix, cut to the host limit', () => {
    expect(nextGroupKey('g', 2, new Set(['g_2']))).toBe('g_3');
    expect(nextGroupKey('abcdefgh', 2, new Set(), 6)).toBe('abcd_2');
  });
});

describe('Repeat down boxes (repeatCountOf / repeatPitchOfText)', () => {
  it('reads a whole number of copies, at least 1, at most REPEAT_MAX', () => {
    expect(repeatCountOf('5')).toBe(5);
    expect(repeatCountOf('5.7')).toBe(5);
    expect(repeatCountOf('500')).toBe(REPEAT_MAX);
    for (const bad of ['', '  ', '0', '-3', 'abc']) expect(repeatCountOf(bad)).toBeNull();
  });
  it('reads a spacing in points, more than 0', () => {
    expect(repeatPitchOfText('26')).toBe(26);
    expect(repeatPitchOfText('12.5')).toBe(12.5);
    for (const bad of ['', '0', '-1', 'x']) expect(repeatPitchOfText(bad)).toBeNull();
  });
});
