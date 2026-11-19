// UAT SIG-03 retest (web ≡ app) — a check box on the signing page is the box itself: a plain
// square with ✓ when checked. Its caption is never squeezed inside the box (a 14 pt box showed
// "Ye"); it sits beside the box, as on the web signing page, and tapping it toggles that box.
// The box keeps its non-overlapping touch area (fieldHitSlop); the caption is a second target.
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
  pageWidth,
  label,
  required,
  checked,
  current,
  hitSlop,
  accessibilityLabel,
  onPress,
  setRef,
}: {
  readonly fieldId: string;
  readonly box: PageBox;
  readonly pageWidth: number;
  readonly label: string | null;
  readonly required: boolean;
  readonly checked: boolean;
  readonly current: boolean;
  readonly hitSlop?: number | Insets;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly setRef?: (r: View | null) => void;
}) {
  const t = useTheme();
  const capSize = Math.max(11, Math.min(15, box.height * 0.95));
  const capLeft = box.left + box.width + 4;
  return (
    <>
      <Pressable
        ref={setRef}
        testID={`field-${fieldId}`}
        onPress={onPress}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        accessibilityLabel={accessibilityLabel}
        hitSlop={hitSlop}
        style={{
          position: 'absolute',
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 2,
          // The current field is a thicker border, never a ring wider than a small box.
          borderWidth: current ? 2 : 1.5,
          borderColor: t.color.accent,
          backgroundColor: checked ? 'rgba(2,42,192,0.06)' : 'rgba(2,42,192,0.09)',
        }}
      >
        {checked ? (
          <Text
            testID={`field-check-${fieldId}`}
            style={{ color: '#0B1F6B', fontSize: Math.max(9, box.height * 0.85), lineHeight: Math.max(10, box.height), fontWeight: '700' }}
          >
            ✓
          </Text>
        ) : null}
      </Pressable>
      {label ? (
        <Pressable
          testID={`field-caption-${fieldId}`}
          onPress={onPress}
          accessible={false}
          style={{
            position: 'absolute',
            left: capLeft,
            top: box.top + box.height / 2 - (capSize * 1.3) / 2,
            maxWidth: Math.max(0, pageWidth - capLeft - 2),
          }}
        >
          <Text numberOfLines={1} style={{ color: t.color.text, fontSize: capSize, lineHeight: capSize * 1.3 }}>
            {required ? label : `${label} · optional`}
          </Text>
        </Pressable>
      ) : null}
    </>
  );
}
