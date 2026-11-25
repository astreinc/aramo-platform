// UAT SIG-03 retest (web ≡ app) — a check box on the signing page is the box itself: a plain
// square with ✓ when checked. PO 2026-11-25 — its label is its name, never words on the page:
// the document's own text says what the box means, so nothing is drawn beside the box (a
// caption there covered or repeated that text). The label stays the box's accessible name
// (accessibilityLabel) and its row in the signer's field list (emptyCaption).
// FIELD-PARITY-1 P3 — the same control draws a RADIO option (`shape="circle"`: a circle, ● when
// chosen, announced as a radio button), and a read-only / sender-filled box (`locked`: shown, not
// a target).
import { Pressable, Text, View, type Insets } from 'react-native';

import { useTheme } from '../../theme';

export interface PageBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function CheckboxField({
  fieldId,
  box,
  checked,
  current,
  hitSlop,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  setRef,
  shape = 'box',
  locked = false,
}: {
  readonly fieldId: string;
  readonly box: PageBox;
  readonly checked: boolean;
  readonly current: boolean;
  readonly hitSlop?: number | Insets;
  readonly accessibilityLabel: string;
  /** The sender's help text (the tooltip setting), read after the label. */
  readonly accessibilityHint?: string;
  readonly onPress: () => void;
  readonly setRef?: (r: View | null) => void;
  readonly shape?: 'box' | 'circle';
  readonly locked?: boolean;
}) {
  const circle = shape === 'circle';
  const t = useTheme();
  return (
    <Pressable
      ref={setRef}
      testID={`field-${fieldId}`}
      onPress={locked ? undefined : onPress}
      {...(locked ? { disabled: true } : {})}
      accessibilityRole={circle ? 'radio' : 'checkbox'}
      accessibilityState={locked ? { checked, disabled: true } : { checked }}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      hitSlop={hitSlop}
      style={{
        position: 'absolute',
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: circle ? Math.max(box.width, box.height) / 2 : 2,
        // The current field is a thicker border, never a ring wider than a small box.
        borderWidth: current ? 2 : 1.5,
        borderColor: locked ? t.color.separator : t.color.accent,
        backgroundColor: checked ? 'rgba(2,42,192,0.06)' : 'rgba(2,42,192,0.09)',
      }}
    >
      {checked ? (
        <Text
          testID={`field-check-${fieldId}`}
          style={{ color: '#0B1F6B', fontSize: Math.max(9, box.height * 0.85), lineHeight: Math.max(10, box.height), fontWeight: '700' }}
        >
          {circle ? '●' : '✓'}
        </Text>
      ) : null}
    </Pressable>
  );
}
