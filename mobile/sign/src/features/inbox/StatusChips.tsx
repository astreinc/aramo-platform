// Agreements status chips (handoff §2A; M-A4 §3.1): All · Needs me {n} · Waiting for
// others · Drafts · Completed. They scroll sideways; the selected chip is filled accent.
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { useTheme } from '../../theme';
import { FILTER_LABEL, FILTERS, type ListFilter } from './agreementsModel';

export function StatusChips({
  value,
  onChange,
  needsCount,
}: {
  readonly value: ListFilter;
  readonly onChange: (f: ListFilter) => void;
  readonly needsCount: number;
}) {
  const t = useTheme();
  const ios = t.platform === 'ios';
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      accessibilityRole="tablist"
    >
      {FILTERS.map((k) => {
        const on = k === value;
        const label =
          k === 'needs_me' && needsCount > 0 ? `${FILTER_LABEL[k]} ${needsCount}` : FILTER_LABEL[k];
        return (
          <Pressable
            key={k}
            testID={`filter-${k}`}
            onPress={() => onChange(k)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={label}
            hitSlop={{ top: 6, bottom: 6 }}
            style={[
              styles.chip,
              {
                minHeight: ios ? 36 : 40,
                backgroundColor: on ? t.color.accent : t.color.surface,
                borderColor: on ? t.color.accent : ios ? 'rgba(60,60,67,0.18)' : '#C6C5D0',
              },
            ]}
          >
            <Text
              numberOfLines={1}
              style={{
                color: on ? t.color.white : t.color.text,
                fontSize: 14,
                fontWeight: on ? '600' : '500',
                fontFamily: t.font.family,
              }}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8, paddingHorizontal: 16 },
  chip: {
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
});
