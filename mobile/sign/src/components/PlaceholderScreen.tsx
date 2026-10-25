// Temporary body for screens a feature workstream has not built yet. Each placeholder
// lives in its own screen file so the owner replaces the file wholesale.
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme';

export function PlaceholderScreen({
  title,
  note,
}: {
  readonly title: string;
  readonly note?: string;
}) {
  const t = useTheme();
  return (
    <View style={[styles.fill, { backgroundColor: t.color.screen }]}>
      <Text
        accessibilityRole="header"
        style={{ color: t.color.text, fontFamily: t.font.family, ...t.type.largeTitle }}
      >
        {title}
      </Text>
      {note ? (
        <Text style={{ color: t.color.textSecondary, fontSize: 15, marginTop: 8 }}>{note}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, padding: 16, paddingTop: 24 } });
