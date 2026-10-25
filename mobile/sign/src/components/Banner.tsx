// Inline banners: the Personal limit banner (handoff §4.10, amber) and the offline
// notice (handoff §6 "Offline · showing saved data"). role=status for screen readers.
import { StyleSheet, Text, View } from 'react-native';

import { BANNER, useTheme } from '../theme';

export function Banner({
  title,
  body,
  tone = 'limit',
}: {
  readonly title?: string;
  readonly body: string;
  readonly tone?: 'limit' | 'offline';
}) {
  const t = useTheme();
  const colors = tone === 'limit' ? BANNER.limit : { bg: t.color.fill, fg: t.color.textSecondary };
  return (
    <View
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      style={[styles.box, { backgroundColor: colors.bg, borderRadius: t.size.cardRadius }]}
    >
      <Text style={{ color: colors.fg, fontSize: 14, lineHeight: 20, fontFamily: t.font.family }}>
        {title ? <Text style={styles.title}>{`${title}\n`}</Text> : null}
        {body}
      </Text>
    </View>
  );
}

export function OfflineBanner() {
  return <Banner tone="offline" body="Offline · showing saved data" />;
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: 14, paddingVertical: 12 },
  title: { fontWeight: '600' },
});
