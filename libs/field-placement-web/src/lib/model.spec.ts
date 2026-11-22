import { FIELD_DEFAULTS, fieldTypesFor } from '@aramo/sign-fields';
import { describe, expect, it } from 'vitest';

import { KEYMAP, editorKeyIntent, fieldKeyIntent, isRedoKey, isUndoKey } from './keymap';
import { DEFAULT_SETTINGS, editableSettingsOf, paletteFor, typeLabelOf, type PlacedField } from './model';
import { applySettings, groupSize } from './settings';

// FIELD-PARITY-1 P1-5 — palette projection per surface, settings ∩ host capabilities, the
// check-box group rules (moved from sign-web field-config.ts) and the one keymap.

describe('paletteFor — the catalog projection per surface', () => {
  it('send_web: the 17 placeable types (FIELD-PARITY-1 P3); PAYMENT only while payments are available (P1-6)', () => {
    const p = paletteFor('send_web');
    expect(p.map((t) => t.type).sort()).toEqual([...fieldTypesFor('send_web')].sort());
    expect(p).toHaveLength(17);
    expect(p.some((t) => t.type === 'PAYMENT')).toBe(false);
    expect(p.some((t) => t.type === 'ACKNOWLEDGEMENT')).toBe(true);
    expect(paletteFor('send_web', { payments_available: true }).some((t) => t.type === 'PAYMENT')).toBe(true);
  });

  it('template_fixed_form: the catalog template types, never PAYMENT; host order and labels; catalog sizes', () => {
    const p = paletteFor('template_fixed_form', { order: ['SIGNATURE', 'INITIALS', 'SIGNER_NAME', 'SIGN_DATE', 'TEXT', 'CHECKBOX'], labels: { SIGN_DATE: 'Date' }, payments_available: true });
    // The host order first, then the rest of the projection (FIELD-PARITY-1 P3 widened it).
    expect(p.map((t) => t.type).slice(0, 6)).toEqual(['SIGNATURE', 'INITIALS', 'SIGNER_NAME', 'SIGN_DATE', 'TEXT', 'CHECKBOX']);
    expect(p.map((t) => t.type).sort()).toEqual([...fieldTypesFor('template_fixed_form')].sort());
    expect(p.some((t) => t.type === 'PAYMENT')).toBe(false);
    expect(p.find((t) => t.type === 'SIGN_DATE')?.label).toBe('Date');
    for (const t of p) expect({ width: t.width, height: t.height, required: t.required }).toEqual(FIELD_DEFAULTS[t.type]);
  });

  it('labels of stored types, known or not', () => {
    expect(typeLabelOf('SIGNER_NAME')).toBe('Name');
    expect(typeLabelOf('SIGN_DATE', { SIGN_DATE: 'Date' })).toBe('Date');
    expect(typeLabelOf('MYSTERY')).toBe('MYSTERY');
  });
});

describe('editableSettingsOf — catalog settings ∩ host capabilities', () => {
  const all = { settings: ['label', 'group_key', 'group_rule', 'min_selected', 'name_mode'] as const };
  it('sign-web edits every Sign setting the type accepts', () => {
    expect(editableSettingsOf('CHECKBOX', all)).toEqual(['label', 'group_key', 'group_rule', 'min_selected']);
    // FIELD-PARITY-1 P3 — label applies to every type now.
    expect(editableSettingsOf('SIGNER_NAME', all)).toEqual(['name_mode', 'label']);
    expect(editableSettingsOf('SIGNATURE', all)).toEqual(['label']);
  });
  it('the console (no settings until P1-3) edits none', () => {
    expect(editableSettingsOf('CHECKBOX', { settings: [] })).toEqual([]);
    expect(editableSettingsOf('NOPE', all)).toEqual([]);
  });
});

const box = (id: string, over: Partial<PlacedField> = {}): PlacedField => ({
  id,
  type: 'CHECKBOX',
  docId: 'd',
  page: 0,
  x: 0,
  y: 0,
  width: 18,
  height: 18,
  required: true,
  assignee: 's1',
  binding: null,
  settings: DEFAULT_SETTINGS,
  ...over,
});

describe('applySettings — check-box groups stay consistent', () => {
  it('a group rule, minimum or required applies to every box of that assignee’s group', () => {
    const g = { ...DEFAULT_SETTINGS, groupKey: 'g' };
    const fields = [box('a', { settings: g }), box('b', { settings: g }), box('c', { settings: g, assignee: 's2' }), box('d')];
    const next = applySettings(fields, 'a', { groupRule: 'SELECT_ONE' });
    expect(next.map((f) => f.settings.groupRule)).toEqual(['SELECT_ONE', 'SELECT_ONE', 'SELECT_ANY', 'SELECT_ANY']);
    const req = applySettings(next, 'b', { required: false });
    expect(req.map((f) => f.required)).toEqual([false, false, true, true]);
  });
  it('joining a group adopts its settings; SELECT_ONE clears the minimum', () => {
    const fields = [box('a', { required: false, settings: { ...DEFAULT_SETTINGS, groupKey: 'g', minSelected: 2 } }), box('b')];
    const joined = applySettings(fields, 'b', { groupKey: 'g' });
    expect(joined[1]).toMatchObject({ required: false, settings: { groupKey: 'g', minSelected: 2 } });
    const one = applySettings(joined, 'a', { groupRule: 'SELECT_ONE' });
    expect(one.map((f) => f.settings.minSelected)).toEqual([null, null]);
    expect(groupSize(one, one[0]!)).toBe(2);
  });
});

describe('the keymap', () => {
  it('arrows move 2pt, Shift 10pt; Alt resizes', () => {
    expect(fieldKeyIntent({ key: 'ArrowLeft' })).toEqual({ kind: 'move', dx: -2, dy: 0 });
    expect(fieldKeyIntent({ key: 'ArrowDown', shiftKey: true })).toEqual({ kind: 'move', dx: 0, dy: 10 });
    expect(fieldKeyIntent({ key: 'ArrowRight', altKey: true })).toEqual({ kind: 'resize', dw: 2, dh: 0 });
    expect(fieldKeyIntent({ key: 'ArrowUp', altKey: true, shiftKey: true })).toEqual({ kind: 'resize', dw: 0, dh: -10 });
  });
  it('Delete / Backspace remove, Escape deselects, Enter / Space select; others are ignored', () => {
    expect(fieldKeyIntent({ key: 'Delete' })).toEqual({ kind: 'delete' });
    expect(fieldKeyIntent({ key: 'Backspace' })).toEqual({ kind: 'delete' });
    expect(fieldKeyIntent({ key: 'Escape' })).toEqual({ kind: 'deselect' });
    expect(fieldKeyIntent({ key: 'Enter' })).toEqual({ kind: 'select' });
    expect(fieldKeyIntent({ key: 'a' })).toBeNull();
  });
  it('P2-2 — Shift+Enter / Shift+Space toggle the focused field in the selection', () => {
    expect(fieldKeyIntent({ key: 'Enter', shiftKey: true })).toEqual({ kind: 'toggle' });
    expect(fieldKeyIntent({ key: ' ', shiftKey: true })).toEqual({ kind: 'toggle' });
    expect(fieldKeyIntent({ key: ' ' })).toEqual({ kind: 'select' });
  });
  it('P2-3 — redo is Shift+Cmd/Ctrl+Z or Ctrl+Y; the editor-wide shortcuts', () => {
    expect(isRedoKey({ key: 'z', metaKey: true, shiftKey: true })).toBe(true);
    expect(isRedoKey({ key: 'Z', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isRedoKey({ key: 'y', ctrlKey: true })).toBe(true);
    expect(isRedoKey({ key: 'z', metaKey: true })).toBe(false);
    expect(editorKeyIntent({ key: 'z', metaKey: true })).toBe('undo');
    expect(editorKeyIntent({ key: 'z', metaKey: true, shiftKey: true })).toBe('redo');
    expect(editorKeyIntent({ key: 'd', metaKey: true })).toBe('duplicate');
    expect(editorKeyIntent({ key: 'D', ctrlKey: true })).toBe('duplicate');
    expect(editorKeyIntent({ key: 'c', ctrlKey: true })).toBe('copy');
    expect(editorKeyIntent({ key: 'v', metaKey: true })).toBe('paste');
    expect(editorKeyIntent({ key: 'a', ctrlKey: true })).toBe('select-all');
    expect(editorKeyIntent({ key: 'd' })).toBeNull();
    expect(editorKeyIntent({ key: 'c', ctrlKey: true, altKey: true })).toBeNull();
    expect(editorKeyIntent({ key: 'v', ctrlKey: true, shiftKey: true })).toBeNull();
  });
  it('KEYMAP lists every shortcut once', () => {
    const keys = KEYMAP.map((k) => k.keys);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of ['Cmd/Ctrl+D', 'Cmd/Ctrl+C', 'Cmd/Ctrl+V', 'Cmd/Ctrl+A', 'Cmd/Ctrl+Z', 'Shift+Cmd/Ctrl+Z or Ctrl+Y', 'Shift while dragging', 'Shift+click']) expect(keys).toContain(k);
  });
  it('Cmd/Ctrl+Z undoes (Shift+Cmd/Ctrl+Z is redo)', () => {
    expect(isUndoKey({ key: 'z', metaKey: true })).toBe(true);
    expect(isUndoKey({ key: 'Z', ctrlKey: true })).toBe(true);
    expect(isUndoKey({ key: 'z', metaKey: true, shiftKey: true })).toBe(false);
    expect(isUndoKey({ key: 'z' })).toBe(false);
  });
});
