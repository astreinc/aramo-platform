// UAT SIG-03 retest (web ≡ app) — the signing page's check box: a plain box (✓ when checked),
// its caption beside it (never inside), and the caption toggles the same box.
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
      pageWidth={300}
      label="Yes"
      required
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
  it('draws the caption beside the box, not inside it', () => {
    show();
    const boxEl = screen.getByTestId('field-yes');
    expect(boxEl).not.toHaveTextContent('Yes');
    const cap = StyleSheet.flatten(screen.getByTestId('field-caption-yes').props.style);
    expect(cap.left).toBe(box.left + box.width + 4);
    expect(screen.getByText('Yes')).toBeTruthy();
  });

  it('tapping the caption or the box toggles that box', () => {
    const onPress = show();
    fireEvent.press(screen.getByTestId('field-caption-yes'));
    fireEvent.press(screen.getByTestId('field-yes'));
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it('shows ✓ only when checked, and reports its state', () => {
    show({ checked: true });
    expect(screen.getByTestId('field-check-yes')).toHaveTextContent('✓');
    expect(screen.getByTestId('field-yes').props.accessibilityState).toEqual({ checked: true });
  });

  it('an optional box says so beside it; no caption without a label', () => {
    show({ required: false });
    expect(screen.getByText('Yes · optional')).toBeTruthy();
  });

  it('no label → no caption', () => {
    show({ label: null });
    expect(screen.queryByTestId('field-caption-yes')).toBeNull();
  });
});
