// List row (handoff §4.2 "Row"): 40px leading tile (iOS radius 10 / Android circle),
// title up to 2 lines, an optional accessory line (pill + secondary text), trailing
// text, and the iOS chevron. Separator per platform tokens.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useTheme } from '../theme';

export interface ListRowProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly leading?: ReactNode;
  readonly accessory?: ReactNode;
  readonly trailing?: string;
  readonly onPress?: () => void;
  readonly showSeparator?: boolean;
  readonly accessibilityLabel?: string;
}

export function RowTile({
  background,
  color,
  children,
}: {
  readonly background: string;
  readonly color: string;
  readonly children?: ReactNode;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.tile,
        { backgroundColor: background, borderRadius: t.platform === 'ios' ? 10 : 20 },
      ]}
    >
      {children ?? (
        <Svg
          width={20}
          height={20}
          viewBox="0 0 24 24"
          fill="none"
          stroke={color}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <Path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6" />
        </Svg>
      )}
    </View>
  );
}

export function ListRow({
  title,
  subtitle,
  leading,
  accessory,
  trailing,
  onPress,
  showSeparator = true,
  accessibilityLabel,
}: ListRowProps) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      android_ripple={t.platform === 'android' ? { color: t.color.fill } : undefined}
      style={({ pressed }) => [
        styles.row,
        { minHeight: t.size.minTouch + 18 },
        showSeparator
          ? { borderBottomWidth: t.size.separatorWidth, borderBottomColor: t.color.separator }
          : null,
        pressed && t.platform === 'ios' ? { backgroundColor: t.color.fill } : null,
      ]}
    >
      {leading}
      <View style={styles.body}>
        <Text
          numberOfLines={2}
          style={{
            color: t.color.text,
            fontFamily: t.font.family,
            ...t.type.rowTitle,
            lineHeight: t.type.rowTitle.fontSize * 1.3,
          }}
        >
          {title}
        </Text>
        {accessory || subtitle ? (
          <View style={styles.accessory}>
            {accessory}
            {subtitle ? (
              <Text
                style={{ color: t.color.textSecondary, fontSize: 13, fontFamily: t.font.family }}
              >
                {subtitle}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
      <View style={styles.trailing}>
        {trailing ? (
          <Text style={{ color: t.color.textSecondary, fontSize: 13, fontFamily: t.font.family }}>
            {trailing}
          </Text>
        ) : null}
        {t.platform === 'ios' && onPress ? (
          <Svg
            width={15}
            height={15}
            viewBox="0 0 24 24"
            fill="none"
            stroke={t.color.textTertiary}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <Path d="M9 6l6 6-6 6" />
          </Svg>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  tile: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, gap: 3 },
  accessory: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  trailing: { alignItems: 'flex-end', gap: 4 },
});
