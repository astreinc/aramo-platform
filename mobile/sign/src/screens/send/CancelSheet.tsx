// Cancel with something added (handoff §4.6): "Save this envelope?" — Save as draft,
// Discard, Keep editing.
import { Text } from 'react-native';

import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { useTheme } from '../../theme';

export function CancelSheet({
  visible,
  busy,
  onSave,
  onDiscard,
  onKeepEditing,
  serverDraftStays,
}: {
  readonly visible: boolean;
  readonly busy: boolean;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly onKeepEditing: () => void;
  /** The envelope already exists on the server: Discard drops only unsaved changes. */
  readonly serverDraftStays: boolean;
}) {
  const t = useTheme();
  return (
    <Sheet visible={visible} onClose={onKeepEditing} title="Save this envelope?">
      <Text style={{ color: t.color.textSecondary, fontSize: 15, lineHeight: 21, fontFamily: t.font.family }}>
        {serverDraftStays
          ? 'You can finish it later from Drafts. Discard drops the changes you haven’t saved.'
          : 'You can finish it later from Drafts.'}
      </Text>
      <Button title="Save as draft" onPress={onSave} busy={busy} />
      <Button
        title={serverDraftStays ? 'Discard changes' : 'Discard'}
        variant="destructive"
        onPress={onDiscard}
        disabled={busy}
      />
      <Button title="Keep editing" variant="text" onPress={onKeepEditing} disabled={busy} />
    </Sheet>
  );
}
