// Step 3 "Fields": the full editor over the real PDF pages (handoff §4.6).
import { useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { FieldEditor } from '../../features/editor/FieldEditor';
import type { EditorField } from '../../features/editor/editorReducer';
import type { SendFlowController, SendFlowState } from '../../features/send/sendFlowController';
import { useTheme } from '../../theme';

export function FieldsStep({
  controller,
  state,
}: {
  readonly controller: SendFlowController;
  readonly state: SendFlowState;
}) {
  const t = useTheme();
  const p = state.draft?.payload;
  const docKeys = (p?.documents ?? []).map((d) => `${d.key}:${d.title}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const documents = useMemo(() => (p?.documents ?? []).map((d) => ({ key: d.key, title: d.title })), [docKeys]);
  const recipientKeys = (p?.recipients ?? []).map((r) => `${r.key}:${r.name}`).join('|');
  const recipients = useMemo(
    () => (p?.recipients ?? []).map((r) => ({ key: r.key, name: r.name })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recipientKeys],
  );
  const loadAsset = useCallback((key: string) => controller.documentAsset(key), [controller]);
  const onFieldsChange = useCallback(
    (fields: readonly EditorField[]) => controller.setFields(fields),
    [controller],
  );
  if (!p) return null;
  if (documents.length === 0 || recipients.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={{ color: t.color.textSecondary, fontSize: 16, textAlign: 'center', fontFamily: t.font.family }}>
          {documents.length === 0 ? 'Add a document first.' : 'Add at least one signer first.'}
        </Text>
      </View>
    );
  }
  return (
    <FieldEditor
      key={state.generation}
      documents={documents}
      recipients={recipients}
      initialFields={p.fields}
      loadAsset={loadAsset}
      onFieldsChange={onFieldsChange}
    />
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
