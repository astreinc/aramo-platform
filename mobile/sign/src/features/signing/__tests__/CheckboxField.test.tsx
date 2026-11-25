// UAT SIG-03 retest (web ≡ app) — the signing page's check box: a plain box (✓ when checked).
// PO 2026-11-25 — no label is drawn on the page, inside or beside the box; the label is the
// box's accessible name.
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { Circle, Path } from 'react-native-svg';

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

  // UAT SIG-03 (Android) — the tick is drawn, never a text glyph that Android clips in a small
  // box, and a checked box is filled so it never looks like an empty one.
  it('a checked box draws the tick (no text glyph) and is filled; an empty box has no mark', () => {
    show({ checked: true });
    const mark = screen.getByTestId('field-check-yes');
    expect(mark).not.toHaveTextContent('✓');
    expect(screen.UNSAFE_getAllByType(Path)).toHaveLength(1);
    expect(screen.getByTestId('field-yes').props.accessibilityState).toEqual({ checked: true });
    const checkedBg = StyleSheet.flatten(screen.getByTestId('field-yes').props.style).backgroundColor;
    screen.unmount();
    show({ checked: false });
    expect(screen.queryByTestId('field-check-yes')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('field-yes').props.style).backgroundColor).not.toBe(checkedBg);
  });

  // FIELD-PARITY-1 P3 T-5 / S-4 — a radio option and a sender's (locked) box.
  it('a radio option is a circle, announced as a radio button, ● when chosen', () => {
    show({ shape: 'circle', checked: true });
    const el = screen.getByTestId('field-yes');
    expect(el.props.accessibilityRole).toBe('radio');
    expect(screen.getByTestId('field-check-yes')).toBeTruthy();
    expect(screen.UNSAFE_getAllByType(Circle)).toHaveLength(1);
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

