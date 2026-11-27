// SIGN-FREE-PARITY-1 S7 — the Agreements folder chips: Any folder · each of the user's folders
// · Folders (make, rename, delete). They scroll sideways like the status chips; the chosen chip
// is filled accent.
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { useTheme } from '../../theme';
import type { SignFolder } from './foldersApi';

function Chip({ label, on, onPress, testID, role = 'tab' }: { readonly label: string; readonly on: boolean; readonly onPress: () => void; readonly testID: string; readonly role?: 'tab' | 'button' }) {
  const t = useTheme();
  const ios = t.platform === 'ios';
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole={role}
      accessibilityState={role === 'tab' ? { selected: on } : undefined}
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
      <Text numberOfLines={1} style={{ color: on ? t.color.white : t.color.text, fontSize: 14, fontWeight: on ? '600' : '500', fontFamily: t.font.family }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function FolderChips({
  folders,
  value,
  onChange,
  onManage,
}: {
  readonly folders: readonly SignFolder[];
  readonly value: string | null;
  readonly onChange: (folderId: string | null) => void;
  readonly onManage: () => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} accessibilityRole="tablist" testID="folder-chips">
      {folders.length > 0 ? <Chip testID="folder-any" label="Any folder" on={value === null} onPress={() => onChange(null)} /> : null}
      {folders.map((f) => (
        <Chip key={f.id} testID={`folder-${f.id}`} label={f.name} on={value === f.id} onPress={() => onChange(f.id)} />
      ))}
      <Chip testID="folder-manage" role="button" label={folders.length > 0 ? 'Folders' : 'New folder'} on={false} onPress={onManage} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8, paddingHorizontal: 16 },
  chip: { borderRadius: 18, borderWidth: 1, paddingHorizontal: 14, justifyContent: 'center' },
});
