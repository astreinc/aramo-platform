import { describe, expect, it } from 'vitest';

import { completionProblem, incompleteMessage, isServerName, requirements, selectOneSiblings } from './field-rules.js';
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
