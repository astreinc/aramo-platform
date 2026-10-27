// Template rows (handoff §2A "Templates"): a 42px tile, the name, the returned metadata
// ("{document type} · Version {n}"), the description and a blue **Use** pill. The whole
// row is one button. Shared by the Templates screen and the Add documents sheet.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { Card } from '../../components/Card';
import { useTheme } from '../../theme';
import type { SenderTemplate } from '../send/templates';
import type { TemplateRowModel } from './templatesModel';

export const ICON_TEMPLATE = 'M4 4h16v16H4zM4 9h16M9 9v11';

export function TemplateRows({
  rows,
  onUse,
  disabled,
}: {
  readonly rows: readonly TemplateRowModel[];
  readonly onUse: (template: SenderTemplate) => void;
  readonly disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <Card>
      {rows.map((r, i) => (
        <Pressable
          key={r.template.id || `${r.title}-${i}`}
          onPress={() => onUse(r.template)}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`Use ${r.accessibilityLabel}`}
          accessibilityState={{ disabled: !!disabled }}
          testID={`template-${i}`}
          android_ripple={t.platform === 'android' ? { color: t.color.fill } : undefined}
          style={({ pressed }) => [
            styles.row,
            { minHeight: t.size.minTouch + 18 },
            i < rows.length - 1
              ? { borderBottomWidth: t.size.separatorWidth, borderBottomColor: t.color.separator }
              : null,
            pressed && t.platform === 'ios' ? { backgroundColor: t.color.fill } : null,
          ]}
        >
          <View style={[styles.tile, { backgroundColor: t.color.tint }]}>
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={t.color.onTint} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <Path d={ICON_TEMPLATE} />
            </Svg>
          </View>
          <View style={styles.text}>
            <Text style={{ color: t.color.text, fontFamily: t.font.family, ...t.type.rowTitle }}>{r.title}</Text>
            {r.meta ? (
              <Text style={{ color: t.color.textSecondary, fontSize: 13, fontFamily: t.font.family }}>{r.meta}</Text>
            ) : null}
            {r.description ? (
              <Text style={{ color: t.color.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 2, fontFamily: t.font.family }}>
                {r.description}
              </Text>
            ) : null}
          </View>
          <View style={[styles.use, { backgroundColor: t.color.accent, opacity: disabled ? 0.42 : 1 }]}>
            <Text style={{ color: t.color.white, fontSize: 14, fontWeight: '600', fontFamily: t.font.family }}>Use</Text>
          </View>
        </Pressable>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 13 },
  tile: { width: 42, height: 42, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, minWidth: 0, gap: 2 },
  use: { minHeight: 32, borderRadius: 16, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
});
