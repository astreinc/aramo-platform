// Swipe left to delete (handoff §4.2 list rows; Drafts only). The row slides to show a
// red Delete action; deleting always asks first. A visible "Delete draft" button on the
// envelope screen is the non-gesture path (accessibility: no action is swipe-only).
import { useRef, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, Text } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';

import { useTheme } from '../../theme';

export const DELETE_DRAFT_TITLE = 'Delete this draft?';
export const DELETE_DRAFT_BODY =
  'Its documents, recipients and fields are removed. This can’t be undone.';

export function confirmDeleteDraft(onConfirm: () => void, onCancel?: () => void): void {
  Alert.alert(DELETE_DRAFT_TITLE, DELETE_DRAFT_BODY, [
    { text: 'Cancel', style: 'cancel', onPress: onCancel },
    { text: 'Delete', style: 'destructive', onPress: onConfirm },
  ]);
}

export function SwipeToDelete({
  enabled,
  label,
  onDelete,
  children,
}: {
  readonly enabled: boolean;
  /** What the row is, for the screen reader ("Delete draft <label>"). */
  readonly label: string;
  readonly onDelete: () => void;
  readonly children: ReactNode;
}) {
  const t = useTheme();
  const ref = useRef<Swipeable>(null);
  if (!enabled) return <>{children}</>;
  return (
    <Swipeable
      ref={ref}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={() => (
        <Pressable
          testID="swipe-delete"
          accessibilityRole="button"
          accessibilityLabel={`Delete draft ${label}`}
          onPress={() => confirmDeleteDraft(onDelete, () => ref.current?.close())}
          style={[styles.action, { backgroundColor: t.color.destructive }]}
        >
          <Text style={styles.text}>Delete</Text>
        </Pressable>
      )}
    >
      {children}
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  action: { width: 88, alignItems: 'center', justifyContent: 'center' },
  text: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
