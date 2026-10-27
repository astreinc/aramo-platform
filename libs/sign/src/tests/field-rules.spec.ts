import { describe, expect, it } from 'vitest';

import { EsignService } from '../lib/esign.service.js';
import { evaluateSignerFieldRules, isServerFilledName, type FieldRuleRow } from '../lib/domain/field-rules.js';

// M-A6 §2.2/§2.3 — the Name and Checkbox completion rules (pure) and the
// server-filled name source.

const at = new Date('2026-10-28T00:00:00Z');
let n = 0;
const f = (o: Partial<FieldRuleRow>): FieldRuleRow => ({ id: `f${(n += 1)}`, field_type: 'CHECKBOX', required: true, value: null, filled_at: null, ...o });
const on = { value: 'true', filled_at: at };
const off = { value: 'false', filled_at: at };

describe('evaluateSignerFieldRules (M-A6 §2.3)', () => {
  it('a required ungrouped check box must be checked; unchecked (false) does not count', () => {
    expect(evaluateSignerFieldRules([f({})])?.reason).toBe('checkbox_required_unchecked');
    expect(evaluateSignerFieldRules([f(off)])?.reason).toBe('checkbox_required_unchecked');
    expect(evaluateSignerFieldRules([f(on)])).toBeNull();
    expect(evaluateSignerFieldRules([f({ required: false, ...off })])).toBeNull();
    expect(evaluateSignerFieldRules([f({ field_type: 'ACKNOWLEDGEMENT', ...off })])?.reason).toBe('checkbox_required_unchecked');
  });

  it('other required fields must be filled', () => {
    expect(evaluateSignerFieldRules([f({ field_type: 'TEXT' })])?.reason).toBe('required_field_unfilled');
    expect(evaluateSignerFieldRules([f({ field_type: 'TEXT', value: 'x', filled_at: at })])).toBeNull();
  });

  it('a SIGNER_PROFILE name is never the signer’s to fill; a SIGNER_ENTERED or legacy name is', () => {
    expect(evaluateSignerFieldRules([f({ field_type: 'SIGNER_NAME', name_mode: 'SIGNER_PROFILE' })])).toBeNull();
    expect(evaluateSignerFieldRules([f({ field_type: 'SIGNER_NAME', name_mode: 'SIGNER_ENTERED' })])?.reason).toBe('required_field_unfilled');
    expect(evaluateSignerFieldRules([f({ field_type: 'SIGNER_NAME', name_mode: null })])?.reason).toBe('required_field_unfilled');
    expect(isServerFilledName({ field_type: 'SIGNER_NAME', name_mode: 'SIGNER_PROFILE' })).toBe(true);
    expect(isServerFilledName({ field_type: 'SIGNER_NAME', name_mode: null })).toBe(false);
  });

  it('SELECT_ONE: exactly one when required, never more than one', () => {
    const g = { group_key: 'g', group_rule: 'SELECT_ONE' };
    expect(evaluateSignerFieldRules([f({ ...g }), f({ ...g })])).toEqual({ reason: 'checkbox_group_select_one', group_key: 'g' });
    expect(evaluateSignerFieldRules([f({ ...g, ...on }), f({ ...g, ...off })])).toBeNull();
    expect(evaluateSignerFieldRules([f({ ...g, ...on }), f({ ...g, ...on })])).toEqual({ reason: 'checkbox_group_select_one', group_key: 'g' });
    expect(evaluateSignerFieldRules([f({ ...g, required: false, ...on }), f({ ...g, required: false, ...on })])?.reason).toBe('checkbox_group_select_one');
    expect(evaluateSignerFieldRules([f({ ...g, required: false }), f({ ...g, required: false })])).toBeNull();
  });

  it('a required SELECT_ANY group needs min_selected (default 1); boxes in a group are not individually required', () => {
    const g = { group_key: 'g', group_rule: 'SELECT_ANY' };
    expect(evaluateSignerFieldRules([f({ ...g, ...on }), f({ ...g, ...off })])).toBeNull();
    expect(evaluateSignerFieldRules([f({ ...g, ...off }), f({ ...g })])).toEqual({ reason: 'checkbox_group_min_selected', group_key: 'g' });
    const two = { ...g, min_selected: 2 };
    expect(evaluateSignerFieldRules([f({ ...two, ...on }), f({ ...two, ...off }), f({ ...two })])?.reason).toBe('checkbox_group_min_selected');
    expect(evaluateSignerFieldRules([f({ ...two, ...on }), f({ ...two, ...on }), f({ ...two })])).toBeNull();
    expect(evaluateSignerFieldRules([f({ ...two, required: false }), f({ ...two, required: false })])).toBeNull();
  });
});

describe('EsignService.profileNameFor (M-A6 §2.2 server-filled name source)', () => {
  const ctx = { session_id: 'ss', tenant_id: 't', envelope_id: 'e', signer_id: 's' };

  it('falls back to Signer.name when no attested-name source is bound', async () => {
    const svc = new EsignService({} as never, {} as never, {} as never);
    await expect(svc.profileNameFor(ctx, 'Alex Rivera')).resolves.toBe('Alex Rivera');
  });

  it('uses the HOSTED attested name when the attested-name port answers, else Signer.name', async () => {
    const queries: unknown[] = [];
    const hosted = { attestedName: async (q: unknown) => { queries.push(q); return '  Alexandra Rivera '; } };
    const svc = new EsignService({} as never, {} as never, {} as never, undefined, hosted);
    await expect(svc.profileNameFor(ctx, 'Alex Rivera')).resolves.toBe('Alexandra Rivera');
    expect(queries).toEqual([ctx]);
    const notHosted = new EsignService({} as never, {} as never, {} as never, undefined, { attestedName: async () => null });
    await expect(notHosted.profileNameFor(ctx, 'Alex Rivera')).resolves.toBe('Alex Rivera');
    const blank = new EsignService({} as never, {} as never, {} as never, undefined, { attestedName: async () => '   ' });
    await expect(blank.profileNameFor(ctx, 'Alex Rivera')).resolves.toBe('Alex Rivera');
  });
});
