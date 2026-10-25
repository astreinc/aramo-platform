// Small presentational pieces shared by the Agreements, detail, signing, notifications
// and account screens (handoff §3, §4). Native-feeling per platform; every control has a
// label and a >= 44/48 pt target.
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { useTheme } from '../../theme';

export function EmptyState({ title, body }: { readonly title: string; readonly body: string }) {
  const t = useTheme();
  return (
    <View style={styles.empty} accessible accessibilityLabel={`${title}. ${body}`}>
      <Text
        style={{
          color: t.color.text,
          fontSize: 17,
          fontWeight: '600',
          fontFamily: t.font.family,
          textAlign: 'center',
        }}
      >
        {title}
      </Text>
      <Text
        style={{
          color: t.color.textSecondary,
          fontSize: 15,
          lineHeight: 21,
          textAlign: 'center',
          fontFamily: t.font.family,
        }}
      >
        {body}
      </Text>
    </View>
  );
}

/** iOS segmented control / Android filter chips (handoff §4.2, §4.3). */
export function Segments<K extends string>({
  items,
  value,
  onChange,
  testIDPrefix,
}: {
  readonly items: readonly { readonly key: K; readonly label: string }[];
  readonly value: K;
  readonly onChange: (k: K) => void;
  readonly testIDPrefix?: string;
}) {
  const t = useTheme();
  if (t.platform === 'android') {
    return (
      <View style={styles.chips} accessibilityRole="tablist">
        {items.map((i) => {
          const on = i.key === value;
          return (
            <Pressable
              key={i.key}
              testID={testIDPrefix ? `${testIDPrefix}-${i.key}` : undefined}
              onPress={() => onChange(i.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              hitSlop={8}
              style={[
                styles.chip,
                on
                  ? { backgroundColor: t.color.tint, borderColor: t.color.tint }
                  : { borderColor: '#767680' },
              ]}
            >
              <Text
                style={{
                  color: on ? t.color.onTint : t.color.textSecondary,
                  fontSize: 14,
                  fontWeight: '500',
                  fontFamily: t.font.family,
                }}
              >
                {on ? `✓ ${i.label}` : i.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  }
  return (
    <View style={[styles.segment, { backgroundColor: t.color.fill }]} accessibilityRole="tablist">
      {items.map((i) => {
        const on = i.key === value;
        return (
          <Pressable
            key={i.key}
            testID={testIDPrefix ? `${testIDPrefix}-${i.key}` : undefined}
            onPress={() => onChange(i.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={[styles.segmentItem, { minHeight: 32 }, on ? styles.segmentOn : null]}
            hitSlop={6}
          >
            <Text
              numberOfLines={1}
              style={{ color: t.color.text, fontSize: 13, fontWeight: on ? '600' : '500' }}
            >
              {i.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ProgressBar({
  fraction,
  color,
  height = 6,
}: {
  readonly fraction: number;
  readonly color: string;
  readonly height?: number;
}) {
  const t = useTheme();
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return (
    <View
      style={{
        height,
        borderRadius: height / 2,
        backgroundColor: t.color.fill,
        overflow: 'hidden',
      }}
    >
      <View
        style={{ width: `${f * 100}%`, height, backgroundColor: color, borderRadius: height / 2 }}
      />
    </View>
  );
}

export function SectionTitle({ children }: { readonly children: string }) {
  const t = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{
        color: t.color.textSecondary,
        fontSize: 13,
        fontWeight: '600',
        textTransform: t.platform === 'ios' ? 'uppercase' : 'none',
        marginTop: 20,
        marginBottom: 6,
        marginHorizontal: 16,
        fontFamily: t.font.family,
      }}
    >
      {children}
    </Text>
  );
}

export function SettingRow({
  title,
  subtitle,
  value,
  onValueChange,
  disabled,
  trailing,
  onPress,
  destructive,
  testID,
  last,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly value?: boolean;
  readonly onValueChange?: (v: boolean) => void;
  readonly disabled?: boolean;
  readonly trailing?: string | ReactNode;
  readonly onPress?: () => void;
  readonly destructive?: boolean;
  readonly testID?: string;
  readonly last?: boolean;
}) {
  const t = useTheme();
  const body = (
    <>
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={{
            color: destructive ? t.color.destructive : t.color.text,
            fontSize: 16,
            fontFamily: t.font.family,
          }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: t.color.textSecondary, fontSize: 13, fontFamily: t.font.family }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {typeof trailing === 'string' ? (
        <Text style={{ color: t.color.textSecondary, fontSize: 15 }}>{trailing}</Text>
      ) : (
        trailing
      )}
      {onValueChange ? (
        <Switch
          testID={testID}
          value={value ?? false}
          onValueChange={onValueChange}
          disabled={disabled}
          accessibilityLabel={title}
          trackColor={{ true: t.color.accent, false: undefined }}
        />
      ) : null}
    </>
  );
  const rowStyle = [
    styles.setting,
    { minHeight: t.size.minTouch + 8, opacity: disabled ? 0.42 : 1 },
    last
      ? null
      : { borderBottomWidth: t.size.separatorWidth, borderBottomColor: t.color.separator },
  ];
  if (onPress && !onValueChange) {
    return (
      <Pressable
        testID={testID}
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ disabled: !!disabled }}
        style={rowStyle}
      >
        {body}
      </Pressable>
    );
  }
  return <View style={rowStyle}>{body}</View>;
}

/** Consent checkbox: circle on iOS, square on Android; never pre-checked by callers. */
export function CheckRow({
  checked,
  onToggle,
  children,
  accessibilityLabel,
  testID,
}: {
  readonly checked: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
  readonly accessibilityLabel: string;
  readonly testID?: string;
}) {
  const t = useTheme();
  const radius = t.platform === 'ios' ? 12 : 3;
  return (
    <Pressable
      testID={testID}
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={accessibilityLabel}
      style={[styles.check, { minHeight: t.size.minTouch }]}
    >
      <View
        style={[
          styles.box,
          {
            borderRadius: radius,
            borderColor: checked ? t.color.accent : t.color.textTertiary,
            backgroundColor: checked ? t.color.accent : 'transparent',
          },
        ]}
      >
        {checked ? (
          <Svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <Path d="M5 12l5 5 9-10" />
          </Svg>
        ) : null}
      </View>
      <View style={{ flex: 1 }}>{children}</View>
    </Pressable>
  );
}

/** A sheet asking for a required reason (void, decline): 3+ characters. */
export function ReasonSheet({
  visible,
  title,
  body,
  confirmLabel,
  placeholder,
  minLength = 3,
  busy,
  error,
  onConfirm,
  onClose,
  disabledReason,
}: {
  readonly visible: boolean;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly placeholder: string;
  readonly minLength?: number;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onConfirm: (reason: string) => void;
  readonly onClose: () => void;
  readonly disabledReason?: string | null;
}) {
  const t = useTheme();
  const [reason, setReason] = useState('');
  const close = () => {
    setReason('');
    onClose();
  };
  const ok = reason.trim().length >= minLength && !disabledReason;
  return (
    <Sheet visible={visible} onClose={close} title={title}>
      <Text
        style={{
          color: t.color.textSecondary,
          fontSize: 15,
          lineHeight: 21,
          fontFamily: t.font.family,
        }}
      >
        {body}
      </Text>
      <TextInput
        testID="reason-input"
        value={reason}
        onChangeText={setReason}
        placeholder={placeholder}
        accessibilityLabel="Reason (required)"
        multiline
        maxLength={500}
        style={{
          minHeight: 88,
          borderWidth: 1,
          borderColor: t.color.separator,
          borderRadius: 10,
          padding: 12,
          fontSize: 16,
          color: t.color.text,
          backgroundColor: t.color.surface,
          textAlignVertical: 'top',
        }}
      />
      {disabledReason ? (
        <Text style={{ color: t.color.textSecondary }}>{disabledReason}</Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: t.color.destructive }}>
          {error}
        </Text>
      ) : null}
      <Button
        testID="reason-confirm"
        title={confirmLabel}
        variant="destructive"
        disabled={!ok}
        busy={busy}
        onPress={() => onConfirm(reason.trim())}
      />
      <Button title="Cancel" variant="text" onPress={close} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 48, paddingHorizontal: 32, gap: 8, alignItems: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16 },
  chip: {
    minHeight: 32,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  segment: { flexDirection: 'row', borderRadius: 9, padding: 2, marginHorizontal: 16 },
  segmentItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  segmentOn: {
    backgroundColor: '#FFFFFF',
    borderRadius: 7,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
  setting: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  check: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  box: { width: 24, height: 24, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
