// UAT SIG-03 retest (web ≡ app) — a check box on the signing page is the box itself: a plain
// square with ✓ when checked. PO 2026-11-25 — its label is its name, never words on the page:
// the document's own text says what the box means, so nothing is drawn beside the box (a
// caption there covered or repeated that text). The label stays the box's accessible name
// (accessibilityLabel) and its row in the signer's field list (emptyCaption).
// UAT SIG-03 (Android) — the mark is drawn (SVG), not a ✓ / ● text glyph: in a 10–14 pt box
// Android's font padding pushed the glyph out of the box, so a checked box looked empty although
// the counter moved. A checked box is also filled (ink background, white tick), so checked and
// empty never look alike.
// FIELD-PARITY-1 P3 — the same control draws a RADIO option (`shape="circle"`: a circle, ● when
// chosen, announced as a radio button), and a read-only / sender-filled box (`locked`: shown, not
// a target).
import { Pressable, View, type Insets } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { useTheme } from '../../theme';

/** The checked mark's ink (the signing page's dark blue, as the ✓ text used before). */
const MARK_INK = '#0B1F6B';

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
        borderColor: locked ? t.color.separator : checked ? MARK_INK : t.color.accent,
        backgroundColor: checked && !circle ? MARK_INK : 'rgba(2,42,192,0.09)',
      }}
    >
      {checked ? (
        <Svg testID={`field-check-${fieldId}`} width="100%" height="100%" viewBox="0 0 24 24" pointerEvents="none">
          {circle ? (
            <Circle cx={12} cy={12} r={6} fill={MARK_INK} />
          ) : (
            <Path d="M5 12.5 L10 17.5 L19 7" stroke="#FFFFFF" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          )}
        </Svg>
      ) : null}
    </Pressable>
  );
}
