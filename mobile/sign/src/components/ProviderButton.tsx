// One federated provider button (handoff §4.1 sign-in buttons). Google and Microsoft keep
// the white outlined style; Apple follows Apple's button rules (Apple Go-Live W3/W4): a
// black button with the white Apple logo and "Sign in with Apple" / "Continue with Apple",
// the same height and corner radius as the others.
import { Pressable, StyleSheet, Text } from 'react-native';

import type { Provider } from '../auth/authorize';
import { useTheme } from '../theme';
import { ProviderLogo } from './BrandMarks';

export interface ProviderButtonProps {
  readonly provider: Provider;
  readonly label: string;
  readonly onPress: () => void;
  readonly busy?: boolean;
  readonly busyLabel?: string;
  /** Another button is busy: this one is disabled and dimmed. */
  readonly dimmed?: boolean;
  readonly disabled?: boolean;
  readonly testID?: string;
}

const APPLE_BLACK = '#000000';
const APPLE_WHITE = '#FFFFFF';

export function ProviderButton({
  provider,
  label,
  onPress,
  busy = false,
  busyLabel,
  dimmed = false,
  disabled = false,
  testID,
}: ProviderButtonProps) {
  const t = useTheme();
  const ios = t.platform === 'ios';
  const apple = provider === 'apple';
  const off = disabled || dimmed || busy;
  const text = busy && busyLabel ? busyLabel : label;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityState={{ disabled: off, busy }}
      android_ripple={ios ? undefined : { color: apple ? '#333333' : t.color.fill }}
      style={({ pressed }) => [
        styles.provider,
        {
          height: t.button.signIn.height,
          borderRadius: t.button.signIn.radius,
          borderColor: apple ? APPLE_BLACK : t.color.signInBorder,
          backgroundColor: apple ? APPLE_BLACK : APPLE_WHITE,
          opacity: dimmed && !busy ? 0.5 : 1,
        },
        pressed && ios ? { backgroundColor: apple ? '#333333' : t.color.fill } : null,
      ]}
    >
      <ProviderLogo provider={provider} size={18} appleColor={APPLE_WHITE} />
      <Text
        maxFontSizeMultiplier={1.6}
        style={{
          color: apple ? APPLE_WHITE : t.color.text,
          fontFamily: t.font.family,
          fontSize: t.button.signIn.fontSize,
          fontWeight: t.button.signIn.fontWeight,
        }}
      >
        {text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  provider: {
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
});
