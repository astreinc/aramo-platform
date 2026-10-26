// The Send flow stepper (handoff §4.6): four 4px segments, Documents · Recipients ·
// Fields · Review. Finished steps are accent and tappable (to go back); the current
// step's label is bold.
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { SendStep } from '../../state/draftStore';
import { useTheme } from '../../theme';

export const STEP_LABELS: Record<SendStep, string> = {
  documents: 'Documents',
  recipients: 'Recipients',
  fields: 'Fields',
  review: 'Review',
};

const ORDER: readonly SendStep[] = ['documents', 'recipients', 'fields', 'review'];

export function Stepper({
  step,
  onStep,
}: {
  readonly step: SendStep;
  readonly onStep: (s: SendStep) => void;
}) {
  const t = useTheme();
  const at = ORDER.indexOf(step);
  return (
    <View style={styles.row} accessibilityRole="tablist">
      {ORDER.map((s, i) => {
        const done = i < at;
        const current = i === at;
        return (
          <Pressable
            key={s}
            disabled={!done}
            onPress={() => onStep(s)}
            accessibilityRole="tab"
            accessibilityLabel={`Step ${i + 1} of 4, ${STEP_LABELS[s]}${done ? ', done' : ''}`}
            accessibilityState={{ selected: current, disabled: !done && !current }}
            style={[styles.item, { minHeight: t.size.minTouch }]}
          >
            <View
              style={[
                styles.bar,
                { backgroundColor: done || current ? t.color.accent : t.color.fill },
              ]}
            />
            <Text
              numberOfLines={1}
              style={{
                color: done ? t.color.accent : current ? t.color.text : t.color.textSecondary,
                fontWeight: current ? '700' : '400',
                fontSize: 12,
                fontFamily: t.font.family,
              }}
            >
              {STEP_LABELS[s]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingTop: 8 },
  item: { flex: 1, gap: 6 },
  bar: { height: 4, borderRadius: 2 },
});
