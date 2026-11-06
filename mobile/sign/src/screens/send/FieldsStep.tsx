// Step 3 "Fields": the full editor over the real PDF pages (handoff §4.6). Only signing
// recipients can be assigned fields: a copy recipient has none (M-A5 §1.5).
// M-A12 W1-C/W1-E: Find searches the documents already uploaded (the server's text
// layer); a placed field starts at the user's default field size.
import { useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useServices } from '../../app/ServicesContext';
import { FieldEditor } from '../../features/editor/FieldEditor';
import { sizeScale } from '../../features/editor/fieldTypes';
import { senderTextLayer } from '../../features/find/textLayerApi';
import type { FindDoc } from '../../features/find/useFind';
import { useSignSettings } from '../../features/profile/signProfile';
import type { EditorField } from '../../features/editor/editorReducer';
import { signingRecipients } from '../../features/send/recipientRoles';
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
  const { workspace } = useServices();
  const settings = useSignSettings();
  // M-A13 #2 — the editor is the bottom of this screen: keep its panel above the system bar.
  const insets = useSafeAreaInsets();
  const p = state.draft?.payload;
  const envelopeId = state.draft?.envelopeId ?? null;
  const uploaded = (p?.documents ?? [])
    .map((d) => `${d.key}:${d.pendingUpload === null && d.serverId ? d.serverId : ''}`)
    .join('|');
  const findDocs = useMemo<readonly FindDoc[]>(
    () =>
      (p?.documents ?? []).map((d) => ({
        docKey: d.key,
        load:
          envelopeId && d.serverId && d.pendingUpload === null
            ? () => senderTextLayer(workspace, envelopeId, d.serverId as string)
            : null,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uploaded, envelopeId, workspace],
  );
  const docKeys = (p?.documents ?? []).map((d) => `${d.key}:${d.title}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const documents = useMemo(() => (p?.documents ?? []).map((d) => ({ key: d.key, title: d.title })), [docKeys]);
  const signing = signingRecipients(p?.recipients ?? []);
  const recipientKeys = signing.map((r) => `${r.key}:${r.name}`).join('|');
  const recipients = useMemo(
    () => signing.map((r) => ({ key: r.key, name: r.name })),
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
      findDocs={findDocs}
      fieldScale={sizeScale(settings.data?.default_field_size)}
      bottomInset={insets.bottom}
    />
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
