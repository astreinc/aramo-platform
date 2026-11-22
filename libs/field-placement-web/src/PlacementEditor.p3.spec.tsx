import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PlacementEditor, type PlacementEditorProps } from './PlacementEditor';
import { DEFAULT_SETTINGS, type PlacedField } from './lib/model';

// FIELD-PARITY-1 P3 §6 — the settings panel in the shared editor: the new types on the palette,
// each type's settings controls, the DROPDOWN choices editor, the NUMBER format, radio "Add
// option", validation parameters, font size, and sender-filled shown only when the host says so.

const DOCS = [{ id: 'd1', title: 'Contract', pages: [{ width: 612, height: 792 }] }];
const ALL_SETTINGS = ['label', 'tooltip', 'placeholder', 'validation', 'font_size', 'data_name', 'options', 'group_key', 'group_rule', 'min_selected', 'name_mode'] as const;

let n = 0;
function setup(over: Partial<PlacementEditorProps> = {}) {
  const onChange = vi.fn();
  const props: PlacementEditorProps = {
    documents: DOCS,
    renderPage: async () => undefined,
    surface: 'send_web',
    fields: [],
    resetKey: 'k',
    onChange,
    assignees: [{ id: 's1', label: 'Ada Lovelace' }],
    capabilities: { settings: ALL_SETTINGS },
    newFieldId: () => `new${(n += 1)}`,
    ...over,
  };
  render(<PlacementEditor {...props} />);
  const last = (): readonly PlacedField[] => (onChange.mock.calls.at(-1)?.[0] as readonly PlacedField[]) ?? [];
  return { onChange, last };
}

const place = (type: string) => {
  fireEvent.click(screen.getByTestId(`fpe-add-${type}`));
  fireEvent.click(screen.getByTestId('fpe-place-keyboard'));
};

describe('PlacementEditor — Phase 3 types and settings', () => {
  it('the send_web palette has every new type and ACKNOWLEDGEMENT', () => {
    setup();
    for (const t of ['ACKNOWLEDGEMENT', 'DATE', 'DROPDOWN', 'RADIO', 'NUMBER', 'MULTILINE_TEXT']) expect(screen.getByTestId(`fpe-add-${t}`)).toBeInTheDocument();
  });

  it('DROPDOWN: starts with two choices; add, edit, reorder and remove choices', () => {
    const { last } = setup();
    place('DROPDOWN');
    expect(last()[0]!.settings.options?.choices).toEqual([
      { value: 'Option 1', label: 'Option 1' },
      { value: 'Option 2', label: 'Option 2' },
    ]);
    fireEvent.click(screen.getByTestId('fpe-choice-add'));
    expect(last()[0]!.settings.options?.choices).toHaveLength(3);
    fireEvent.change(screen.getByTestId('fpe-choice-label-2'), { target: { value: 'Maybe' } });
    fireEvent.change(screen.getByTestId('fpe-choice-value-2'), { target: { value: 'm' } });
    expect(last()[0]!.settings.options?.choices?.[2]).toEqual({ value: 'm', label: 'Maybe' });
    fireEvent.click(screen.getByTestId('fpe-choice-up-2'));
    expect(last()[0]!.settings.options?.choices?.map((c) => c.label)).toEqual(['Option 1', 'Maybe', 'Option 2']);
    // Editing a label whose value follows it keeps them together.
    fireEvent.change(screen.getByTestId('fpe-choice-label-0'), { target: { value: 'Yes' } });
    expect(last()[0]!.settings.options?.choices?.[0]).toEqual({ value: '', label: 'Yes' });
    fireEvent.click(screen.getByTestId('fpe-choice-remove-1'));
    expect(last()[0]!.settings.options?.choices?.map((c) => c.label)).toEqual(['Yes', 'Option 2']);
    expect(screen.queryByTestId('fpe-settings-issue')).toBeNull();
    fireEvent.click(screen.getByTestId('fpe-choice-remove-0'));
    fireEvent.click(screen.getByTestId('fpe-choice-remove-0'));
    // The ONE settings rule refuses a dropdown with no choices: shown before the host saves.
    expect(screen.getByTestId('fpe-settings-issue')).toHaveTextContent('a dropdown needs 1 to 50 choices');
  });

  it('RADIO: a new one gets its own group; "Add option" adds a sibling below in the group (one undo step)', () => {
    const { last } = setup();
    place('RADIO');
    const first = last()[0]!;
    expect(first.settings).toMatchObject({ groupKey: 'radio_1', label: 'Option 1' });
    expect(screen.getByTestId('fpe-radio-count')).toHaveTextContent('1 options in this group');
    fireEvent.click(screen.getByTestId('fpe-radio-add'));
    const [, second] = last();
    expect(second).toMatchObject({ type: 'RADIO', x: first.x, y: first.y - first.height - 8, settings: { groupKey: 'radio_1', label: 'Option 2' } });
    expect(screen.getByTestId('fpe-radio-count')).toHaveTextContent('2 options in this group');
    expect(screen.queryByTestId('fpe-checkbox-rule')).toBeNull();
    fireEvent.change(screen.getByTestId('fpe-label'), { target: { value: 'No' } });
    expect(last()[1]!.settings.label).toBe('No');
    // A second radio set is a new group.
    place('RADIO');
    expect(last()[2]!.settings.groupKey).toBe('radio_2');
  });

  it('NUMBER: money format with currency and decimals; number range with min / max', () => {
    const { last } = setup();
    place('NUMBER');
    fireEvent.change(screen.getByTestId('fpe-number-format-select'), { target: { value: 'money' } });
    expect(last()[0]!.settings.options).toEqual({ format: 'money', currency: 'USD', decimals: 2 });
    fireEvent.change(screen.getByTestId('fpe-number-currency'), { target: { value: 'eur' } });
    fireEvent.change(screen.getByTestId('fpe-number-decimals'), { target: { value: '0' } });
    expect(last()[0]!.settings.options).toEqual({ format: 'money', currency: 'EUR', decimals: 0 });
    fireEvent.change(screen.getByTestId('fpe-validation'), { target: { value: 'number_range' } });
    expect(screen.getByTestId('fpe-settings-issue')).toHaveTextContent('number_range needs min or max');
    fireEvent.change(screen.getByTestId('fpe-number-min'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('fpe-number-max'), { target: { value: '500' } });
    expect(last()[0]!.settings).toMatchObject({ validation: 'number_range', options: { min: 1, max: 500 } });
    expect(screen.queryByTestId('fpe-settings-issue')).toBeNull();
  });

  it('DATE: date range; TEXT: validation presets and max length; font size auto / fixed; placeholder, tooltip, data name', () => {
    const { last } = setup();
    place('DATE');
    fireEvent.change(screen.getByTestId('fpe-validation'), { target: { value: 'date_range' } });
    fireEvent.change(screen.getByTestId('fpe-date-min'), { target: { value: '2026-01-01' } });
    expect(last()[0]!.settings.options).toEqual({ min_date: '2026-01-01' });
    place('TEXT');
    const presets = Array.from((screen.getByTestId('fpe-validation') as HTMLSelectElement).options).map((o) => o.value);
    expect(presets).toEqual(['', 'email', 'phone', 'us_zip', 'max_length']);
    fireEvent.change(screen.getByTestId('fpe-validation'), { target: { value: 'max_length' } });
    expect(last()[1]!.settings).toMatchObject({ validation: 'max_length', options: { max_length: 100 } });
    fireEvent.change(screen.getByTestId('fpe-font-size-mode'), { target: { value: 'fixed' } });
    fireEvent.change(screen.getByTestId('fpe-font-size'), { target: { value: '99' } });
    expect(last()[1]!.settings.fontSize).toBe(36);
    fireEvent.change(screen.getByTestId('fpe-font-size-mode'), { target: { value: 'auto' } });
    expect(last()[1]!.settings.fontSize).toBeNull();
    fireEvent.change(screen.getByTestId('fpe-placeholder'), { target: { value: 'Your city' } });
    fireEvent.change(screen.getByTestId('fpe-tooltip'), { target: { value: 'Where you live' } });
    fireEvent.change(screen.getByTestId('fpe-data-name'), { target: { value: 'Bad Name' } });
    expect(screen.getByTestId('fpe-settings-issue')).toHaveTextContent('data_name is lower_snake_case');
    fireEvent.change(screen.getByTestId('fpe-data-name'), { target: { value: 'city' } });
    expect(last()[1]!.settings).toMatchObject({ placeholder: 'Your city', tooltip: 'Where you live', dataName: 'city' });
  });

  it('sender-filled is hidden unless the host lists it; then the sender types a value and may make it read-only', () => {
    setup();
    place('TEXT');
    expect(screen.queryByTestId('fpe-sender-filled')).toBeNull();
    expect(screen.queryByTestId('fpe-read-only')).toBeNull();
  });

  it('sender-filled on (host flag): value input per type, read-only, the value rule', () => {
    const { last } = setup({ capabilities: { settings: [...ALL_SETTINGS, 'read_only', 'sender_filled'], senderValues: true } });
    place('NUMBER');
    fireEvent.click(screen.getByTestId('fpe-sender-filled'));
    expect(screen.queryByTestId('fpe-read-only')).not.toBeNull();
    fireEvent.change(screen.getByTestId('fpe-sender-value'), { target: { value: 'abc' } });
    expect(screen.getByTestId('fpe-sender-value-issue')).toHaveTextContent('number value invalid');
    fireEvent.change(screen.getByTestId('fpe-sender-value'), { target: { value: '12.5' } });
    expect(screen.queryByTestId('fpe-sender-value-issue')).toBeNull();
    fireEvent.click(screen.getByTestId('fpe-read-only'));
    expect(last()[0]!.settings).toMatchObject({ senderFilled: true, senderValue: '12.5', readOnly: true });
    fireEvent.click(screen.getByTestId('fpe-sender-filled'));
    expect(last()[0]!.settings).toMatchObject({ senderFilled: false, senderValue: '', readOnly: false });
    place('DROPDOWN');
    fireEvent.click(screen.getByTestId('fpe-sender-filled'));
    expect(screen.getByTestId('fpe-sender-value').tagName).toBe('SELECT');
  });

  it('ACKNOWLEDGEMENT shows label, tooltip and data name only', () => {
    setup({ fields: [{ id: 'a', type: 'ACKNOWLEDGEMENT', docId: 'd1', page: 0, x: 10, y: 10, width: 400, height: 26, required: true, assignee: 's1', binding: null, settings: DEFAULT_SETTINGS }] });
    fireEvent.focus(screen.getByTestId('fpe-field-a'));
    expect(screen.getByTestId('fpe-label')).toBeInTheDocument();
    expect(screen.getByTestId('fpe-tooltip')).toBeInTheDocument();
    expect(screen.getByTestId('fpe-data-name')).toBeInTheDocument();
    expect(screen.queryByTestId('fpe-placeholder')).toBeNull();
    expect(screen.queryByTestId('fpe-validation')).toBeNull();
  });
});
