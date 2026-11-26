// Step 3 "Fields": the full editor over the real PDF pages (handoff §4.6). Only signing
// recipients can be assigned fields: a copy recipient has none (M-A5 §1.5).
// M-A12 W1-C/W1-E: Find searches the documents already uploaded (the server's text
// layer); a placed field starts at the user's default field size.
// FIELD-PARITY-1 P2-4: "Find fields" reads the server's detector for the uploaded documents.
import { useCallback, useEffect, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useOnline } from '../../features/inbox/queries';
import { draftNeedsUpload } from '../../features/send/draftModel';
import { useServices } from '../../app/ServicesContext';
import { FieldEditor, type SuggestDoc } from '../../features/editor/FieldEditor';
import { fetchSenderSuggestions } from '../../features/editor/senderSuggestions';
import { sizeScale } from '../../features/editor/fieldTypes';
import { senderTextLayer } from '../../features/find/textLayerApi';
import type { FindDoc } from '../../features/find/useFind';
import { useSignSettings } from '../../features/profile/signProfile';
import type { EditorField } from '../../features/editor/editorReducer';
import { signingRecipients } from '../../features/send/recipientRoles';
import type { SendFlowController, SendFlowState } from '../../features/send/sendFlowController';
import { ErrorText } from '../../features/send/ui';
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
        pending: !(envelopeId && d.serverId && d.pendingUpload === null),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uploaded, envelopeId, workspace],
  );
  const suggestDocs = useMemo<readonly SuggestDoc[]>(
    () =>
      (p?.documents ?? []).map((d) => ({
        docKey: d.key,
        load:
          envelopeId && d.serverId && d.pendingUpload === null
            ? () => fetchSenderSuggestions(workspace, envelopeId, d.serverId as string)
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
  // Android field test 2026-11-25 — Find and "Find fields" read the server copy of a document. A
  // PDF added online is uploaded at once (UAT DOC-06); one added offline is not, so entering this
  // step (and coming back online) saves the draft, which uploads the documents; their text and
  // suggestions load as soon as they are on the server.
  const online = useOnline();
  const needsUpload = draftNeedsUpload(envelopeId, p?.documents ?? []);
  useEffect(() => {
    if (online && needsUpload) void controller.sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);
  const loadAsset = useCallback((key: string) => controller.documentAsset(key), [controller]);
  const onFieldsChange = useCallback(
    (fields: readonly EditorField[]) => controller.setFields(fields),
    [controller],
  );
  if (!p) return null;
  // UAT DOC-06 — a refusal from the sync above (storage full, …) shows here, as on Documents
  // and Review, instead of being swallowed.
  const error = state.error ? (
    <View style={styles.error}>
      <ErrorText>{state.error}</ErrorText>
    </View>
  ) : null;
  if (documents.length === 0 || recipients.length === 0) {
    return (
      <View style={styles.fill}>
        {error}
        <View style={styles.empty}>
          <Text style={{ color: t.color.textSecondary, fontSize: 16, textAlign: 'center', fontFamily: t.font.family }}>
            {documents.length === 0 ? 'Add a document first.' : 'Add at least one signer first.'}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.fill}>
      {error}
      <FieldEditor
        key={state.generation}
        documents={documents}
        recipients={recipients}
        initialFields={p.fields}
        loadAsset={loadAsset}
        onFieldsChange={onFieldsChange}
        findDocs={findDocs}
        suggestDocs={suggestDocs}
        fieldScale={sizeScale(settings.data?.default_field_size)}
        bottomInset={insets.bottom}
        senderFilledEnabled={p.senderFilledEnabled === true}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  error: { paddingHorizontal: 16, paddingVertical: 8 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
