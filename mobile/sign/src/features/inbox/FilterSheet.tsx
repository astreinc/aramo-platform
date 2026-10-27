// "Filter agreements" sheet (handoff §2A; M-A4 §3.2): a Status list and a Last activity
// list with checkmarks, and Done. Selections apply immediately; Done closes.
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { useTheme } from '../../theme';
import {
  FILTER_HEADING,
  FILTERS,
  RANGE_LABEL,
  RANGES,
  type ListFilter,
  type ListRange,
} from './agreementsModel';

function OptionList<K extends string>({
  title,
  options,
  value,
  onChange,
  testIDPrefix,
}: {
  readonly title: string;
  readonly options: readonly { readonly key: K; readonly label: string }[];
  readonly value: K;
  readonly onChange: (k: K) => void;
  readonly testIDPrefix: string;
}) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text
        accessibilityRole="header"
        style={[
          styles.section,
          {
            color: t.color.textSecondary,
            fontFamily: t.font.family,
            textTransform: 'uppercase',
          },
        ]}
      >
        {title}
      </Text>
      <View
        accessibilityRole="radiogroup"
        style={[
          styles.group,
          {
            backgroundColor: t.color.surface,
            borderRadius: t.platform === 'ios' ? 12 : 16,
            borderWidth: t.platform === 'ios' ? 0 : 1,
            borderColor: t.color.separator,
          },
        ]}
      >
        {options.map((o, i) => {
          const on = o.key === value;
          return (
            <Pressable
              key={o.key}
              testID={`${testIDPrefix}-${o.key}`}
              onPress={() => onChange(o.key)}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={o.label}
              style={[
                styles.option,
                { minHeight: t.size.minTouch },
                i < options.length - 1
                  ? {
                      borderBottomWidth: t.size.separatorWidth,
                      borderBottomColor: t.color.separator,
                    }
                  : null,
              ]}
            >
              <Text
                style={{ flex: 1, color: t.color.text, fontSize: 16, fontFamily: t.font.family }}
              >
                {o.label}
              </Text>
              <Text style={{ color: t.color.accent, fontSize: 17, fontWeight: '600' }}>
                {on ? '✓' : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function FilterSheet({
  visible,
  filter,
  range,
  onFilter,
  onRange,
  onClose,
}: {
  readonly visible: boolean;
  readonly filter: ListFilter;
  readonly range: ListRange;
  readonly onFilter: (f: ListFilter) => void;
  readonly onRange: (r: ListRange) => void;
  readonly onClose: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Filter agreements">
      <OptionList
        title="Status"
        options={FILTERS.map((k) => ({ key: k, label: FILTER_HEADING[k] }))}
        value={filter}
        onChange={onFilter}
        testIDPrefix="filter-status"
      />
      <OptionList
        title="Last activity"
        options={RANGES.map((k) => ({ key: k, label: RANGE_LABEL[k] }))}
        value={range}
        onChange={onRange}
        testIDPrefix="filter-range"
      />
      <Button testID="filter-done" title="Done" onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 13, fontWeight: '500', marginHorizontal: 4 },
  group: { overflow: 'hidden' },
  option: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 12 },
});
