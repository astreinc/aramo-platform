// FIELD-PARITY-1 P3 §6 — the signing page's field editor per type: DATE (month picker inside
// date_range), NUMBER (money prefix, decimal keypad), DROPDOWN (choices), MULTILINE_TEXT
// (counter), TEXT presets; label, tooltip, placeholder; inline errors announced.
import { fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { FieldEditor } from '../FieldEditor';
import type { SigningField } from '../signingMachine';

const TODAY = new Date(2026, 2, 10); // March 2026

function field(type: string, over: Partial<SigningField> = {}): SigningField {
  return { field_id: 'f1', document_id: 'd1', field_type: type, page_number: 0, x: 0, y: 0, width: 120, height: 24, required: true, ...over };
}

function show(f: SigningField, initial = '', dateFormat: string | null = null) {
  const onSave = jest.fn();
  render(<FieldEditor field={f} initial={initial} dateFormat={dateFormat} onSave={onSave} today={TODAY} />);
  return onSave;
}

beforeEach(() => {
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('FieldEditor', () => {
  it('DATE: days outside date_range cannot be chosen; stored YYYY-MM-DD; previewed in the envelope format', () => {
    const onSave = show(field('DATE', { label: 'Start date', validation: 'date_range', options: { min_date: '2026-03-05', max_date: '2026-04-20' } }), '', 'DD/MM/YYYY');
    expect(screen.getByTestId('date-month')).toHaveTextContent('March 2026');
    expect(screen.getByTestId('date-prev').props.accessibilityState).toEqual({ disabled: true });
    expect(screen.getByTestId('date-2026-03-04').props.accessibilityState).toEqual({ selected: false, disabled: true });
    expect(screen.getByTestId('field-editor-hint')).toHaveTextContent('From 05/03/2026 to 20/04/2026');
    fireEvent.press(screen.getByTestId('date-2026-03-04'));
    expect(screen.getByTestId('date-preview')).toHaveTextContent('Choose a date');
    fireEvent.press(screen.getByTestId('date-next'));
    expect(screen.getByTestId('date-month')).toHaveTextContent('April 2026');
    expect(screen.getByTestId('date-next').props.accessibilityState).toEqual({ disabled: true });
    fireEvent.press(screen.getByTestId('date-2026-04-02'));
    expect(screen.getByTestId('date-2026-04-02').props.accessibilityState).toEqual({ selected: true, disabled: false });
    expect(screen.getByTestId('date-2026-04-02').props.accessibilityLabel).toBe('02/04/2026');
    expect(screen.getByTestId('date-preview')).toHaveTextContent('Shown on the document as 02/04/2026');
    fireEvent.press(screen.getByTestId('text-field-save'));
    expect(onSave).toHaveBeenCalledWith('2026-04-02');
  });

  it('DATE opens on the stored value', () => {
    show(field('DATE'), '2027-11-30');
    expect(screen.getByTestId('date-month')).toHaveTextContent('November 2027');
    expect(screen.getByTestId('date-2027-11-30').props.accessibilityState.selected).toBe(true);
  });

  it('NUMBER: money prefix, decimal keypad, placeholder; a refused value is named, announced and kept out', () => {
    const onSave = show(field('NUMBER', { label: 'Salary', placeholder: '0.00', validation: 'number_range', options: { format: 'money', currency: 'USD', decimals: 2, min: 1, max: 1000 } }));
    const input = screen.getByTestId('text-field-input');
    expect(screen.getByTestId('field-editor-prefix', { includeHiddenElements: true })).toHaveTextContent('$');
    expect(input.props.keyboardType).toBe('decimal-pad');
    expect(input.props.placeholder).toBe('0.00');
    expect(input.props.accessibilityLabel).toBe('Salary');
    expect(screen.getByTestId('field-editor-hint')).toHaveTextContent('Amount in USD · From $1.00 to $1,000.00');
    fireEvent.changeText(input, '5000');
    fireEvent.press(screen.getByTestId('text-field-save'));
    expect(screen.getByText('Enter a number from $1.00 to $1,000.00.')).toBeTruthy();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Enter a number from $1.00 to $1,000.00.');
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.changeText(input, '$1,0.5');
    expect(screen.queryByText('Enter a number from $1.00 to $1,000.00.')).toBeNull();
    fireEvent.press(screen.getByTestId('text-field-save'));
    expect(onSave).toHaveBeenCalledWith('10.5');
  });

  it('NUMBER allowing negatives gets a keyboard with a minus sign', () => {
    show(field('NUMBER', { validation: 'number_range', options: { min: -10, max: 10 } }));
    expect(screen.getByTestId('text-field-input').props.keyboardType).toBe('numbers-and-punctuation');
  });

  it('DROPDOWN: the sender’s choices, one chosen; the value is the choice’s value', () => {
    const onSave = show(field('DROPDOWN', { label: 'Office', options: { choices: [{ value: 'nyc', label: 'New York' }, { value: 'blr', label: 'Bengaluru' }] } }), 'nyc');
    expect(screen.getByTestId('choice-list').props.accessibilityRole).toBe('radiogroup');
    expect(screen.getByTestId('choice-nyc').props.accessibilityState).toEqual({ checked: true });
    fireEvent.press(screen.getByTestId('choice-blr'));
    expect(screen.getByTestId('choice-blr').props.accessibilityState).toEqual({ checked: true });
    expect(screen.getByTestId('choice-nyc').props.accessibilityState).toEqual({ checked: false });
    fireEvent.press(screen.getByTestId('text-field-save'));
    expect(onSave).toHaveBeenCalledWith('blr');
  });

  it('MULTILINE_TEXT: multi-line input with the max_length counter', () => {
    const onSave = show(field('MULTILINE_TEXT', { label: 'Notes', required: false, validation: 'max_length', options: { max_length: 40 } }));
    const input = screen.getByTestId('text-field-input');
    expect(input.props.multiline).toBe(true);
    expect(input.props.maxLength).toBe(40);
    expect(screen.getByTestId('field-editor-label')).toHaveTextContent('Notes (optional)');
    expect(screen.getByTestId('field-editor-count')).toHaveTextContent('0 / 40');
    fireEvent.changeText(input, 'Line one\nLine two');
    expect(screen.getByTestId('field-editor-count')).toHaveTextContent('17 / 40');
    fireEvent.press(screen.getByTestId('text-field-save'));
    expect(onSave).toHaveBeenCalledWith('Line one\nLine two');
  });

  it('TEXT presets pick the keyboard and are checked before saving; the tooltip is the help text', () => {
    const onSave = show(field('TEXT', { label: 'Work email', tooltip: 'We send the copy here', validation: 'email' }));
    const input = screen.getByTestId('text-field-input');
    expect(input.props.keyboardType).toBe('email-address');
    expect(screen.getByTestId('field-editor-help')).toHaveTextContent('We send the copy here');
    expect(input.props.accessibilityHint).toBe('We send the copy here. An email address');
    fireEvent.changeText(input, 'nope');
    fireEvent.press(screen.getByTestId('text-field-save'));
    expect(screen.getByText('Enter a valid email address, like name@example.com.')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('the phone preset uses the phone keypad', () => {
    show(field('TEXT', { validation: 'phone' }));
    expect(screen.getByTestId('text-field-input').props.keyboardType).toBe('phone-pad');
  });

  it('a plain text field: 500 characters, and saving empty clears it', () => {
    const onSave = show(field('TEXT'), 'old');
    const input = screen.getByTestId('text-field-input');
    expect(input.props.maxLength).toBe(500);
    fireEvent.changeText(input, '  ');
    fireEvent.press(screen.getByTestId('text-field-save'));
    expect(onSave).toHaveBeenCalledWith('');
  });
});
