// FIELD-PARITY-1 P1-3 — the template field settings rule. Runs under vitest and mobile Jest
// (globals only).
import {
  FIELD_TYPE_KEYS,
  NO_TEMPLATE_FIELD_SETTINGS,
  TEMPLATE_FIELD_SETTINGS,
  checkboxGroupIssues,
  fieldSettingsOf,
  parseTemplateFieldSettings,
  templateNameModeOf,
  templateSettingsOf,
  type GroupedTemplateField,
} from '../index.js';

describe('FIELD-PARITY-1 P1-3 — which settings a template field type takes', () => {
  it('is the catalog settings without the PAYMENT ones (P1-6)', () => {
    for (const t of FIELD_TYPE_KEYS) {
      // The same set (in TEMPLATE_FIELD_SETTINGS order).
      expect([...templateSettingsOf(t)].sort()).toEqual(fieldSettingsOf(t).filter((s) => (TEMPLATE_FIELD_SETTINGS as readonly string[]).includes(s)).sort());
    }
    // FIELD-PARITY-1 P3 §6.2 — label, tooltip and data_name on every type; the rest per type.
    expect(templateSettingsOf('SIGNER_NAME')).toEqual(['label', 'name_mode', 'tooltip', 'placeholder', 'font_size', 'data_name']);
    expect(templateSettingsOf('CHECKBOX')).toEqual(['label', 'group_key', 'group_rule', 'min_selected', 'tooltip', 'read_only', 'sender_filled', 'data_name']);
    expect(templateSettingsOf('RADIO')).toEqual(['label', 'group_key', 'group_rule', 'tooltip', 'read_only', 'sender_filled', 'data_name']);
    expect(templateSettingsOf('PAYMENT')).toEqual([]);
    expect(templateSettingsOf('MULTILINE_TEXT')).toEqual(['label', 'tooltip', 'placeholder', 'read_only', 'sender_filled', 'validation', 'font_size', 'data_name', 'options']);
    expect(templateSettingsOf('NOT_A_TYPE')).toEqual([]);
  });
});

describe('FIELD-PARITY-1 P1-3 — parseTemplateFieldSettings', () => {
  it('absent or null settings are none (a SIGNER_NAME keeps name_mode NULL)', () => {
    expect(parseTemplateFieldSettings({}, 'SIGNATURE')).toEqual({ ok: true, settings: NO_TEMPLATE_FIELD_SETTINGS });
    expect(parseTemplateFieldSettings({ label: null, group_key: null, group_rule: null, min_selected: null, name_mode: null }, 'SIGNATURE')).toEqual({
      ok: true,
      settings: NO_TEMPLATE_FIELD_SETTINGS,
    });
    expect(parseTemplateFieldSettings({}, 'SIGNER_NAME')).toEqual({ ok: true, settings: NO_TEMPLATE_FIELD_SETTINGS });
  });

  it('a setting the type does not take is refused, never ignored', () => {
    const r = parseTemplateFieldSettings({ placeholder: 'Agree' }, 'SIGNATURE');
    expect(r).toEqual({ ok: false, refusal: expect.objectContaining({ setting: 'placeholder', reason: 'field_config_not_applicable' }) });
    expect(parseTemplateFieldSettings({ name_mode: 'SIGNER_ENTERED' }, 'CHECKBOX')).toMatchObject({ ok: false, refusal: { setting: 'name_mode', reason: 'field_config_not_applicable' } });
    expect(parseTemplateFieldSettings({ group_key: 'g' }, 'MULTILINE_TEXT')).toMatchObject({ ok: false, refusal: { setting: 'group_key', reason: 'field_config_not_applicable' } });
  });

  it('SIGNER_NAME takes SIGNER_PROFILE or SIGNER_ENTERED', () => {
    expect(parseTemplateFieldSettings({ name_mode: 'SIGNER_ENTERED' }, 'SIGNER_NAME')).toEqual({ ok: true, settings: { ...NO_TEMPLATE_FIELD_SETTINGS, name_mode: 'SIGNER_ENTERED' } });
    expect(parseTemplateFieldSettings({ name_mode: 'TYPED' }, 'SIGNER_NAME')).toMatchObject({ ok: false, refusal: { setting: 'name_mode', reason: 'name_mode_invalid' } });
  });

  it('CHECKBOX label, group and rule follow Sign (trim; SELECT_ANY default; SELECT_ONE ⇒ min 1)', () => {
    expect(parseTemplateFieldSettings({ label: '  I agree  ' }, 'CHECKBOX')).toEqual({ ok: true, settings: { ...NO_TEMPLATE_FIELD_SETTINGS, label: 'I agree' } });
    expect(parseTemplateFieldSettings({ label: '   ' }, 'CHECKBOX')).toEqual({ ok: true, settings: NO_TEMPLATE_FIELD_SETTINGS });
    expect(parseTemplateFieldSettings({ label: 'x'.repeat(201) }, 'CHECKBOX')).toMatchObject({ ok: false, refusal: { reason: 'checkbox_label_invalid' } });
    expect(parseTemplateFieldSettings({ label: 3 }, 'CHECKBOX')).toMatchObject({ ok: false, refusal: { reason: 'checkbox_label_invalid' } });
    expect(parseTemplateFieldSettings({ group_key: 'colour' }, 'CHECKBOX')).toEqual({
      ok: true,
      settings: { ...NO_TEMPLATE_FIELD_SETTINGS, group_key: 'colour', group_rule: 'SELECT_ANY' },
    });
    expect(parseTemplateFieldSettings({ group_key: 'colour', group_rule: 'SELECT_ANY', min_selected: 2 }, 'CHECKBOX')).toEqual({
      ok: true,
      settings: { ...NO_TEMPLATE_FIELD_SETTINGS, group_key: 'colour', group_rule: 'SELECT_ANY', min_selected: 2 },
    });
    expect(parseTemplateFieldSettings({ group_key: 'k'.repeat(65) }, 'CHECKBOX')).toMatchObject({ ok: false, refusal: { setting: 'group_key', reason: 'checkbox_group_invalid' } });
    expect(parseTemplateFieldSettings({ group_key: 'c', group_rule: 'ALL' }, 'CHECKBOX')).toMatchObject({ ok: false, refusal: { setting: 'group_rule', reason: 'checkbox_group_invalid' } });
    expect(parseTemplateFieldSettings({ group_key: 'c', min_selected: 0 }, 'CHECKBOX')).toMatchObject({ ok: false, refusal: { setting: 'min_selected', reason: 'checkbox_group_invalid' } });
    expect(parseTemplateFieldSettings({ group_key: 'c', min_selected: 1.5 }, 'CHECKBOX')).toMatchObject({ ok: false, refusal: { setting: 'min_selected', reason: 'checkbox_group_invalid' } });
    expect(parseTemplateFieldSettings({ group_key: 'c', group_rule: 'SELECT_ONE', min_selected: 2 }, 'CHECKBOX')).toMatchObject({
      ok: false,
      refusal: { setting: 'min_selected', reason: 'checkbox_group_invalid' },
    });
    expect(parseTemplateFieldSettings({ group_rule: 'SELECT_ONE' }, 'CHECKBOX')).toMatchObject({ ok: false, refusal: { setting: 'group_rule', reason: 'checkbox_group_required' } });
    expect(parseTemplateFieldSettings({ min_selected: 1 }, 'CHECKBOX')).toMatchObject({ ok: false, refusal: { setting: 'min_selected', reason: 'checkbox_group_required' } });
  });
});

describe('FIELD-PARITY-1 P1-3 — checkboxGroupIssues', () => {
  const box = (field_key: string, over: Partial<GroupedTemplateField> = {}): GroupedTemplateField => ({
    field_key,
    signer_role: 'employee',
    required: true,
    group_key: 'g',
    group_rule: 'SELECT_ONE',
    min_selected: null,
    ...over,
  });

  it('a consistent group (and ungrouped boxes) has no issue', () => {
    expect(checkboxGroupIssues([box('a'), box('b'), box('c', { group_key: null, group_rule: null })])).toEqual([]);
  });

  it('boxes of one group must share the signer role, rule, minimum and required setting', () => {
    expect(checkboxGroupIssues([box('a'), box('b', { signer_role: 'manager' })])).toEqual([expect.objectContaining({ group_key: 'g', reason: 'checkbox_group_inconsistent' })]);
    expect(checkboxGroupIssues([box('a'), box('b', { group_rule: 'SELECT_ANY' })])).toEqual([expect.objectContaining({ reason: 'checkbox_group_inconsistent' })]);
    expect(checkboxGroupIssues([box('a'), box('b', { required: false })])).toEqual([expect.objectContaining({ reason: 'checkbox_group_inconsistent' })]);
  });

  it('the minimum is not more than the boxes in the group', () => {
    const any = { group_rule: 'SELECT_ANY', min_selected: 3 };
    expect(checkboxGroupIssues([box('a', any), box('b', any)])).toEqual([expect.objectContaining({ reason: 'checkbox_group_min_exceeds_size' })]);
  });
});

describe('FIELD-PARITY-1 P1-4 — templateNameModeOf', () => {
  it('NULL is the default SIGNER_PROFILE; a stored mode is kept; other types carry none', () => {
    expect(templateNameModeOf('SIGNER_NAME', null)).toBe('SIGNER_PROFILE');
    expect(templateNameModeOf('SIGNER_NAME', undefined)).toBe('SIGNER_PROFILE');
    expect(templateNameModeOf('SIGNER_NAME', 'SIGNER_ENTERED')).toBe('SIGNER_ENTERED');
    expect(templateNameModeOf('TEXT', 'SIGNER_ENTERED')).toBeNull();
  });
});
