// UAT SIG-03 retest (web ≡ app) — the signing page's check box: a plain box (✓ when checked).
// PO 2026-11-25 — no label is drawn on the page, inside or beside the box; the label is the
// box's accessible name.
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { CheckboxField } from '../CheckboxField';

const box = { left: 40, top: 100, width: 10, height: 10 };

function show(over: Partial<Parameters<typeof CheckboxField>[0]> = {}) {
  const onPress = jest.fn();
  render(
    <CheckboxField
      fieldId="yes"
      box={box}
      checked={false}
      current={false}
      accessibilityLabel="Yes, check box"
      onPress={onPress}
      {...over}
    />,
  );
  return onPress;
}

describe('CheckboxField', () => {
  it('draws no label on the page, inside or beside the box; the label is its accessible name', () => {
    show();
    expect(screen.queryByText(/Yes/)).toBeNull();
    expect(screen.queryByTestId('field-caption-yes')).toBeNull();
    expect(screen.getByTestId('field-yes').props.accessibilityLabel).toBe('Yes, check box');
  });

  it('tapping the box toggles it', () => {
    const onPress = show();
    fireEvent.press(screen.getByTestId('field-yes'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows ✓ only when checked, and reports its state', () => {
    show({ checked: true });
    expect(screen.getByTestId('field-check-yes')).toHaveTextContent('✓');
    expect(screen.getByTestId('field-yes').props.accessibilityState).toEqual({ checked: true });
  });

  // FIELD-PARITY-1 P3 T-5 / S-4 — a radio option and a sender's (locked) box.
  it('a radio option is a circle, announced as a radio button, ● when chosen', () => {
    show({ shape: 'circle', checked: true });
    const el = screen.getByTestId('field-yes');
    expect(el.props.accessibilityRole).toBe('radio');
    expect(screen.getByTestId('field-check-yes')).toHaveTextContent('●');
    expect(StyleSheet.flatten(el.props.style).borderRadius).toBe(5);
  });

  it('a locked box is shown but not a target; the tooltip is its hint', () => {
    const onPress = show({ locked: true, checked: true, accessibilityHint: 'Set by the sender' });
    const el = screen.getByTestId('field-yes');
    expect(el.props.accessibilityState).toEqual({ checked: true, disabled: true });
    expect(el.props.accessibilityHint).toBe('Set by the sender');
    fireEvent.press(el);
    expect(onPress).not.toHaveBeenCalled();
  });
});

