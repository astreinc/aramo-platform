import { describe, expect, it } from 'vitest';

import { completionProblem, incompleteMessage, isLocked, isRadio, isServerName, requirements, selectOneSiblings } from './field-rules.js';
import type { SignField } from './sign-api.js';

// M-A6 §2.3 — the signer page mirrors the server's completion rules.

const f = (field_id: string, over: Partial<SignField> = {}): SignField => ({
  field_id, document_id: 'd', field_type: 'CHECKBOX', page_number: 0, x: 0, y: 0, width: 14, height: 14, required: true, ...over,
});

describe('completion rules (M-A6 §2.3)', () => {
  it('a required ungrouped box must be checked; false is not enough', () => {
    const fields = [f('a')];
    expect(completionProblem(fields, {})).not.toBeNull();
    expect(completionProblem(fields, { a: 'false' })).not.toBeNull();
    expect(completionProblem(fields, { a: 'true' })).toBeNull();
    expect(completionProblem([f('b', { required: false })], {})).toBeNull();
  });

  it('SELECT_ONE: never more than one; exactly one when required', () => {
    const g = { group_key: 'g', group_rule: 'SELECT_ONE' as const };
    const fields = [f('a', g), f('b', g)];
    expect(completionProblem(fields, {})).toMatch(/one option/);
    expect(completionProblem(fields, { a: 'true' })).toBeNull();
    expect(completionProblem(fields, { a: 'true', b: 'true' })).toMatch(/only one/);
    const optional = [f('a', { ...g, required: false }), f('b', { ...g, required: false })];
    expect(completionProblem(optional, {})).toBeNull();
    expect(completionProblem(optional, { a: 'true', b: 'true' })).toMatch(/only one/);
  });

  it('a required SELECT_ANY group needs min_selected (default 1)', () => {
    const g = { group_key: 'g', group_rule: 'SELECT_ANY' as const, min_selected: 2 };
    const fields = [f('a', g), f('b', g), f('c', g)];
    expect(completionProblem(fields, { a: 'true' })).toMatch(/at least 2/);
    expect(completionProblem(fields, { a: 'true', c: 'true' })).toBeNull();
    const d1 = [f('a', { group_key: 'h', group_rule: 'SELECT_ANY' }), f('b', { group_key: 'h', group_rule: 'SELECT_ANY', required: false })];
    expect(completionProblem(d1, {})).toMatch(/at least 1/);
    expect(completionProblem(d1, { b: 'true' })).toBeNull();
  });

  it('a server-filled name is never a signer requirement; a legacy name is', () => {
    const name = f('n', { field_type: 'SIGNER_NAME', name_mode: 'SIGNER_PROFILE', server_filled: true, value: 'Ada' });
    expect(isServerName(name)).toBe(true);
    expect(requirements([name], {})).toEqual([]);
    const legacy = f('l', { field_type: 'SIGNER_NAME', name_mode: null });
    expect(isServerName(legacy)).toBe(false);
    expect(completionProblem([legacy], {})).not.toBeNull();
    expect(completionProblem([legacy], { l: 'Ada' })).toBeNull();
  });

  it('SELECT_ONE siblings and server reasons', () => {
    const g = { group_key: 'g', group_rule: 'SELECT_ONE' as const };
    const fields = [f('a', g), f('b', g), f('c')];
    expect(selectOneSiblings(fields, fields[0] as SignField).map((x) => x.field_id)).toEqual(['b']);
    expect(selectOneSiblings(fields, fields[2] as SignField)).toEqual([]);
    expect(incompleteMessage('checkbox_group_select_one')).toMatch(/exactly one/);
    expect(incompleteMessage(undefined)).toMatch(/required fields/);
  });
});

// FIELD-PARITY-1 P3 §6 — radio groups (T-5) and the sender's values (S-4 / S-5).
describe('FIELD-PARITY-1 P3 completion rules', () => {
  const r = (id: string, over: Partial<SignField> = {}) => f(id, { field_type: 'RADIO', group_key: 'g', group_rule: 'SELECT_ONE', ...over });

  it('a required radio group needs exactly one choice; never two', () => {
    const fields = [r('a'), r('b')];
    expect(isRadio(fields[0] as SignField)).toBe(true);
    expect(completionProblem(fields, {})).toBe('Choose one option in each required set of choices.');
    expect(completionProblem(fields, { a: 'true', b: 'false' })).toBeNull();
    expect(completionProblem(fields, { a: 'true', b: 'true' })).toBe('Choose only one option in each set of choices.');
    expect(requirements(fields, {})).toHaveLength(1);
  });

  it('an optional radio group may stay empty', () => {
    expect(completionProblem([r('a', { required: false }), r('b', { required: false })], {})).toBeNull();
  });

  it('radio siblings are cleared whatever the stored group rule', () => {
    const fields = [r('a', { group_rule: null }), r('b', { group_rule: null }), r('c', { group_key: 'other' })];
    expect(selectOneSiblings(fields, fields[0] as SignField).map((x) => x.field_id)).toEqual(['b']);
  });

  it('a sender-filled / read-only field is never a requirement', () => {
    const locked = f('t', { field_type: 'TEXT', read_only: true, sender_filled: true, value: 'ACME' });
    expect(isLocked(locked)).toBe(true);
    expect(requirements([locked], {})).toEqual([]);
    const lockedBox = f('b', { read_only: true, sender_filled: true });
    expect(completionProblem([lockedBox], {})).toBeNull();
  });

  it('the new types are ordinary required fields', () => {
    for (const t of ['DATE', 'DROPDOWN', 'NUMBER', 'MULTILINE_TEXT']) {
      expect(completionProblem([f('x', { field_type: t })], {})).toBe('Some required fields still need your input.');
      expect(completionProblem([f('x', { field_type: t })], { x: 'v' })).toBeNull();
    }
  });

  it('the server’s radio refusal at Finish', () => {
    expect(incompleteMessage('radio_group_select_one')).toBe('Choose exactly one option in each set of choices.');
  });
});
