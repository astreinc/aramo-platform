// Buttons per handoff §3: primary (accent), secondary (iOS tinted / Android outlined),
// text, and destructive. Disabled at 42% opacity; touch targets >= 44/48 pt.
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { DISABLED_OPACITY, useTheme } from '../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'text' | 'destructive';

export interface ButtonProps {
  readonly title: string;
  readonly onPress: () => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly icon?: ReactNode;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  busy,
  icon,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: ButtonProps) {
  const t = useTheme();
  const isText = variant === 'text';
  const container: ViewStyle = {
    minHeight: isText ? t.size.minTouch : t.button.primary.height,
    borderRadius: t.button.primary.radius,
    paddingHorizontal: isText ? 8 : 20,
    opacity: disabled ? DISABLED_OPACITY : 1,
  };
  let fg = t.color.white;
  if (variant === 'primary') container.backgroundColor = t.color.accent;
  if (variant === 'secondary') {
    fg = t.color.accent;
    if (t.button.secondary === 'tinted') container.backgroundColor = t.color.tint;
    else
      Object.assign(container, {
        borderWidth: 1,
        borderColor: t.button.outline,
        backgroundColor: 'transparent',
      });
  }
  if (variant === 'text') fg = t.color.accent;
  if (variant === 'destructive') {
    fg = t.color.destructive;
    container.backgroundColor = t.platform === 'ios' ? t.color.destructiveTint : 'transparent';
  }
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      android_ripple={t.platform === 'android' ? { color: t.color.fill } : undefined}
      style={({ pressed }) => [
        styles.base,
        container,
        pressed && t.platform === 'ios' ? styles.pressed : null,
        style,
      ]}
    >
      <View style={styles.row}>
        {busy ? <ActivityIndicator color={fg} /> : icon}
        <Text
          style={{
            color: fg,
            fontSize: t.button.primary.fontSize,
            fontWeight: t.button.primary.fontWeight,
            fontFamily: t.font.family,
          }}
          maxFontSizeMultiplier={2}
        >
          {title}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pressed: { opacity: 0.7 },
});
