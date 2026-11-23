import { describe, expect, it } from 'vitest';

import { cloneFields, repeatDown, type CloneContext } from './clone';
import {
  TRIGGER_TYPES,
  clearStaleConditions,
  conditionWhensFor,
  defaultConditionFor,
  dependentsOf,
  previewShownIds,
  remapConditions,
  setPreviewAnswer,
  staleConditionIds,
  usableTriggers,
} from './conditions';
import { editorReducer, initialEditorState, removeFields, type CommandContext } from './editor-state';
import { DEFAULT_SETTINGS, type PlacedField, type PlacementSettings } from './model';
import { applySettings } from './settings';

// FIELD-PARITY-2 B-7 — authoring "Show only when…" in the shared web editor: which fields may be a
// trigger (the shared cross-field rule), the starting rule, a deleted or retyped trigger clearing
// its dependents (one undo step), copies following their copied trigger, and the preview (the ONE
// visibility rule).

const PAGE = { width: 612, height: 792 };
const ctx: CommandContext = { pageSize: () => PAGE, precision: 'integer' };

let y = 700;
function field(id: string, type: string, over: Partial<Omit<PlacedField, 'settings'>> & { settings?: Partial<PlacementSettings> } = {}): PlacedField {
  const { settings, ...rest } = over;
  y -= 30;
  return { id, type, docId: 'd', page: 0, x: 50, y, width: 100, height: 20, required: false, assignee: 's1', binding: null, settings: { ...DEFAULT_SETTINGS, ...settings }, ...rest };
}
const when = (trigger_key: string, w: 'checked' | 'unchecked' | 'chosen' | 'one_of' = 'checked', values?: string[]) => ({ trigger_key, when: w, ...(values ? { values } : {}) });

describe('the trigger types and rules', () => {
  it('a check box / acknowledgement is checked or not; a radio option is chosen; a dropdown is one of', () => {
    expect([...TRIGGER_TYPES].sort()).toEqual(['ACKNOWLEDGEMENT', 'CHECKBOX', 'DROPDOWN', 'RADIO']);
    expect(conditionWhensFor('CHECKBOX')).toEqual(['checked', 'unchecked']);
    expect(conditionWhensFor('RADIO')).toEqual(['chosen']);
    expect(conditionWhensFor('DROPDOWN')).toEqual(['one_of']);
    expect(conditionWhensFor('TEXT')).toEqual([]);
  });

  it('a picked trigger starts with checked / chosen / the first choice; a dropdown without choices offers none', () => {
    expect(defaultConditionFor(field('cb', 'CHECKBOX'))).toEqual(when('cb'));
    expect(defaultConditionFor(field('r', 'RADIO'))).toEqual(when('r', 'chosen'));
    const dd = field('dd', 'DROPDOWN', { settings: { options: { choices: [{ value: ' ', label: '' }, { value: 'b', label: 'B' }] } } });
    expect(defaultConditionFor(dd)).toEqual(when('dd', 'one_of', ['b']));
    expect(defaultConditionFor(field('e', 'DROPDOWN'))).toBeNull();
    expect(defaultConditionFor(field('t', 'TEXT'))).toBeNull();
  });
});

describe('usableTriggers (the shared rule decides)', () => {
  it('offers only same-signer fields of a trigger type, never the field itself, a locked, prefilled, sender-filled or unplaced one', () => {
    const fields = [
      field('dep', 'TEXT'),
      field('cb', 'CHECKBOX'),
      field('ack', 'ACKNOWLEDGEMENT'),
      field('other', 'CHECKBOX', { assignee: 's2' }),
      field('txt', 'TEXT'),
      field('locked', 'CHECKBOX', { locked: true }),
      field('hidden', 'CHECKBOX', { hidden: true }),
      field('mine', 'CHECKBOX', { settings: { senderFilled: true } }),
      field('emptydd', 'DROPDOWN'),
    ];
    expect(usableTriggers(fields, 'dep').map((f) => f.id)).toEqual(['cb', 'ack']);
  });

  it('never offers a loop or a chain deeper than 3', () => {
    // a ← b ← c (b shows when a, c shows when b); offering c as the trigger of a would loop.
    const loop = [field('a', 'CHECKBOX'), field('b', 'CHECKBOX', { settings: { condition: when('a') } }), field('c', 'CHECKBOX', { settings: { condition: when('b') } })];
    expect(usableTriggers(loop, 'a').map((f) => f.id)).toEqual([]);
    expect(usableTriggers(loop, 'c').map((f) => f.id)).toEqual(['a', 'b']);
    // d ← c ← b ← a is depth 3; a text field under d would be depth 4.
    const deep = [...loop, field('d', 'CHECKBOX', { settings: { condition: when('c') } }), field('t', 'TEXT')];
    expect(usableTriggers(deep, 't').map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('a field the sender fills, or one with nobody to fill it, takes no trigger', () => {
    const fields = [field('cb', 'CHECKBOX'), field('mine', 'TEXT', { settings: { senderFilled: true } }), field('pre', 'TEXT', { assignee: null, binding: 'v' })];
    expect(usableTriggers(fields, 'mine')).toEqual([]);
    expect(usableTriggers(fields, 'pre')).toEqual([]);
  });
});

describe('a deleted or retyped trigger clears its dependents (B-7)', () => {
  it('delete: the dependents lose their condition in the same undo step; undo brings both back', () => {
    const fields = [field('cb', 'CHECKBOX'), field('t1', 'TEXT', { settings: { condition: when('cb') } }), field('t2', 'TEXT', { settings: { condition: when('cb', 'unchecked') } }), field('x', 'TEXT')];
    expect(dependentsOf(fields, ['cb'])).toEqual(['t1', 't2']);
    let s = initialEditorState(fields);
    s = editorReducer(s, { type: 'exec', command: removeFields(['cb']) }, ctx);
    expect(s.fields.map((f) => [f.id, f.settings.condition])).toEqual([
      ['t1', null],
      ['t2', null],
      ['x', null],
    ]);
    // Untouched fields keep their identity (history records only real changes).
    expect(s.fields[2]).toBe(fields[3]);
    expect(s.past).toHaveLength(1);
    s = editorReducer(s, { type: 'undo' }, ctx);
    expect(s.fields).toEqual(fields);
  });

  it('retype: a trigger that is no longer a type its rule reads (or is gone) leaves a stale condition, cleared', () => {
    const fields = [field('cb', 'TEXT'), field('t1', 'TEXT', { settings: { condition: when('cb') } }), field('t2', 'TEXT', { settings: { condition: when('gone') } }), field('ok', 'CHECKBOX'), field('t3', 'TEXT', { settings: { condition: when('ok') } })];
    expect(staleConditionIds(fields)).toEqual(['t1', 't2']);
    const cleared = clearStaleConditions(fields);
    expect(cleared.map((f) => f.settings.condition?.trigger_key ?? null)).toEqual([null, null, null, null, 'ok']);
    expect(cleared[4]).toBe(fields[4]);
  });

  it('a field made sender-filled loses its condition (D-4)', () => {
    const fields = [field('cb', 'CHECKBOX'), field('t', 'TEXT', { settings: { condition: when('cb') } })];
    expect(applySettings(fields, 't', { senderFilled: true })[1]!.settings.condition).toBeNull();
  });
});

describe('copies follow their copied trigger', () => {
  const cctx: CloneContext = { pageSize: () => PAGE, precision: 'integer', newId: (type, all) => `${type.toLowerCase()}_${all.length + 1}` };

  it('duplicate / paste: copied together, the copy names the copied trigger; alone, it keeps the original', () => {
    const cb = field('cb', 'CHECKBOX');
    const t = field('t', 'TEXT', { settings: { condition: when('cb') } });
    const both = cloneFields([cb, t], [cb, t], { dx: 10, dy: 10 }, cctx);
    expect(both.map((f) => [f.id, f.settings.condition?.trigger_key ?? null])).toEqual([
      ['checkbox_3', null],
      ['text_4', 'checkbox_3'],
    ]);
    expect(cloneFields([cb, t], [t], { dx: 10, dy: 10 }, cctx)[0]!.settings.condition).toEqual(when('cb'));
  });

  it('Repeat down: each new row’s field names that row’s trigger', () => {
    const cb = field('cb', 'CHECKBOX', { y: 700 });
    const t = field('t', 'TEXT', { y: 700, x: 200, settings: { condition: when('cb') } });
    const r = repeatDown([cb, t], [cb, t], { count: 2, pitch: 30 }, cctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.map((f) => [f.id, f.settings.condition?.trigger_key ?? null])).toEqual([
      ['checkbox_3', null],
      ['text_4', 'checkbox_3'],
      ['checkbox_5', null],
      ['text_6', 'checkbox_5'],
    ]);
  });

  it('remapConditions leaves other conditions alone', () => {
    const t = field('t', 'TEXT', { settings: { condition: when('x') } });
    expect(remapConditions([t], new Map([['y', 'z']]))[0]).toBe(t);
  });
});

describe('the preview (the ONE visibility rule)', () => {
  const dd = field('dd', 'DROPDOWN', { settings: { options: { choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } } });
  const fields = [
    field('cb', 'CHECKBOX'),
    field('yes', 'TEXT', { settings: { condition: when('cb') } }),
    field('no', 'TEXT', { settings: { condition: when('cb', 'unchecked') } }),
    field('chain', 'TEXT', { settings: { condition: when('yes2') } }),
    field('r1', 'RADIO', { settings: { groupKey: 'g', label: 'One' } }),
    field('r2', 'RADIO', { settings: { groupKey: 'g', label: 'Two' } }),
    field('onr1', 'TEXT', { settings: { condition: when('r1', 'chosen') } }),
    dd,
    field('ondd', 'TEXT', { settings: { condition: when('dd', 'one_of', ['b']) } }),
  ];

  it('with no answers: checked / chosen / one_of dependents are hidden, unchecked ones shown', () => {
    const shown = previewShownIds(fields, new Map());
    expect(['yes', 'onr1', 'ondd'].map((id) => shown.has(id))).toEqual([false, false, false]);
    expect(['cb', 'no', 'r1', 'dd'].map((id) => shown.has(id))).toEqual([true, true, true, true]);
    // A dangling trigger fails open (shown), as the signer apps do.
    expect(shown.has('chain')).toBe(true);
  });

  it('answers show and hide dependents; choosing a radio option un-chooses its siblings', () => {
    let a = setPreviewAnswer(new Map(), fields, fields[0]!);
    a = setPreviewAnswer(a, fields, fields[4]!);
    a = setPreviewAnswer(a, fields, dd, 'b');
    let shown = previewShownIds(fields, a);
    expect(['yes', 'no', 'onr1', 'ondd'].map((id) => shown.has(id))).toEqual([true, false, true, true]);
    a = setPreviewAnswer(a, fields, fields[5]!);
    expect(a.get('r1')).toBeUndefined();
    a = setPreviewAnswer(a, fields, fields[0]!);
    a = setPreviewAnswer(a, fields, dd, '');
    shown = previewShownIds(fields, a);
    expect(['yes', 'no', 'onr1', 'ondd'].map((id) => shown.has(id))).toEqual([false, true, false, false]);
  });
});

describe('the inline refusal reads choices as they are saved', () => {
  it('a one_of value naming a choice whose value follows its label is not refused', async () => {
    const { conditionIssues } = await import('./settings-wire');
    const dd = field('dd', 'DROPDOWN', { settings: { options: { choices: [{ value: '', label: 'Yes' }, { value: 'n', label: 'No' }] } } });
    const t = field('t', 'TEXT', { settings: { condition: when('dd', 'one_of', ['Yes']) } });
    expect(conditionIssues([dd, t]).has('t')).toBe(false);
    expect(conditionIssues([dd, { ...t, settings: { ...t.settings, condition: when('dd', 'one_of', ['Maybe']) } }]).get('t')?.reason).toBe('condition_values_invalid');
  });
});
