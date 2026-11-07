// M-A14 — the buttons the post-Finish screens share. Heights are minimums so they grow
// with the user's font size; every target is at least 44pt / 48dp.
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../../../theme';
import { ACCENT, INK, LineIcon, OUTLINE, WHITE, type IconName } from './art';

/** The prototype keeps the bottom button 34pt above the screen edge (home indicator included). */
export function bottomPad(insetBottom: number): number {
  return Math.max(insetBottom, 20) + 4;
}

export function OutlinedButton({
  title,
  onPress,
  testID,
  borderColor = OUTLINE,
  radius = 6,
  fontSize = 18,
}: {
  readonly title: string;
  readonly onPress: () => void;
  readonly testID?: string;
  readonly borderColor?: string;
  readonly radius?: number;
  readonly fontSize?: number;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.outlined,
        { borderColor, borderRadius: radius, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={[styles.outlinedText, { fontSize, fontFamily: t.font.family }]}>{title}</Text>
    </Pressable>
  );
}

export function FilledButton({
  title,
  onPress,
  testID,
  radius = 4,
}: {
  readonly title: string;
  readonly onPress: () => void;
  readonly testID?: string;
  readonly radius?: number;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.filled,
        { borderRadius: radius, opacity: pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={[styles.filledText, { fontFamily: t.font.family }]}>{title}</Text>
    </Pressable>
  );
}

export function TextAction({
  title,
  onPress,
  testID,
}: {
  readonly title: string;
  readonly onPress: () => void;
  readonly testID?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.textAction, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={[styles.textActionText, { fontFamily: t.font.family }]}>{title}</Text>
    </Pressable>
  );
}

/** A 66-across ink circle with a white line icon and a label under it. */
export function CircleAction({
  icon,
  label,
  accessibilityLabel,
  onPress,
  busy,
  disabled,
  testID,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly testID?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.circleAction, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={[styles.circle, { opacity: disabled && !busy ? 0.5 : 1 }]}>
        {busy ? <ActivityIndicator color={WHITE} /> : <LineIcon name={icon} />}
      </View>
      <Text style={[styles.circleLabel, { fontFamily: t.font.family }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  outlined: {
    alignSelf: 'stretch',
    minHeight: 50,
    borderWidth: 1.5,
    backgroundColor: WHITE,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  outlinedText: { color: INK, fontSize: 18, fontWeight: '400', textAlign: 'center' },
  filled: {
    alignSelf: 'stretch',
    minHeight: 50,
    backgroundColor: INK,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  filledText: { color: WHITE, fontSize: 17, fontWeight: '500', textAlign: 'center' },
  textAction: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  textActionText: { color: ACCENT, fontSize: 17, fontWeight: '500', textAlign: 'center' },
  circleAction: { alignItems: 'center', gap: 14, minWidth: 66 },
  circle: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: INK,
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleLabel: { color: INK, fontSize: 17, fontWeight: '400' },
});
