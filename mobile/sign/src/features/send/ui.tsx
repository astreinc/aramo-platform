// Small building blocks shared by the Send flow screens and sheets (new files only;
// the foundation components are reused as they are).
import { forwardRef } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { useTheme } from '../../theme';

export const TextField = forwardRef<
  TextInput,
  TextInputProps & {
    readonly label: string;
    readonly hint?: string;
    readonly error?: string | null;
  }
>(function TextField({ label, hint, error, style, ...props }, ref) {
  const t = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: t.color.textSecondary, fontFamily: t.font.family }]}>
        {label}
        {hint ? <Text style={styles.hint}>{` ${hint}`}</Text> : null}
      </Text>
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        placeholderTextColor={t.color.textTertiary}
        style={[
          styles.input,
          {
            minHeight: t.size.minTouch + 4,
            color: t.color.text,
            backgroundColor: t.color.surface,
            borderRadius: t.platform === 'ios' ? 10 : 4,
            borderColor: error ? t.color.destructive : (t.color.surfaceBorder ?? t.color.separator),
            fontFamily: t.font.family,
          },
          style,
        ]}
        {...props}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" style={{ color: t.color.destructive, fontSize: 13 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
});

export function StepTitle({ children }: { readonly children: string }) {
  const t = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={[styles.title, { color: t.color.text, fontFamily: t.font.family }]}
    >
      {children}
    </Text>
  );
}

export function ErrorText({ children }: { readonly children: string | null | undefined }) {
  const t = useTheme();
  if (!children) return null;
  return (
    <Text
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={{
        color: t.color.destructive,
        fontSize: 14,
        lineHeight: 20,
        fontFamily: t.font.family,
      }}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '500', marginLeft: 4 },
  hint: { fontWeight: '400' },
  input: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  title: { fontSize: 22, fontWeight: '700' },
});
