// Status pill (handoff §3): 11.5/600; radius 6 (iOS) / 8 (Android). `NEEDS_ME` renders
// the solid "Sign now" pill used in list rows.
import { StyleSheet, Text, View } from 'react-native';

import { STATUS_PILL, useTheme, type PillStatus } from '../theme';

export function StatusPill({ status }: { readonly status: PillStatus }) {
  const t = useTheme();
  const p = STATUS_PILL[status];
  return (
    <View
      style={[styles.pill, { backgroundColor: p.bg, borderRadius: t.size.pillRadius }]}
      accessibilityRole="text"
      accessibilityLabel={p.label}
    >
      <Text style={[styles.label, { color: p.fg, fontFamily: t.font.family }]}>{p.label}</Text>
    </View>
  );
}

export function isPillStatus(s: string): s is PillStatus {
  return Object.prototype.hasOwnProperty.call(STATUS_PILL, s);
}

const styles = StyleSheet.create({
  pill: { alignSelf: 'flex-start', paddingHorizontal: 7, paddingVertical: 1.5 },
  label: { fontSize: 11.5, fontWeight: '600' },
});
