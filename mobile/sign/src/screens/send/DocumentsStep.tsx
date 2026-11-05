// Step 1 "What do you want to send?" (handoff §4.6 + §2A; directive §5 as amended by
// M-A4 §5).
//   - The Personal limit banner first, when it applies (from the billing account).
//   - The documents added so far, each removable.
//   - **Add documents** opens the Add documents sheet (Scan · Photos · Templates · Files).
//     A new, empty envelope opens the sheet straight away (the + flows open it).
//   - Templates appear in the sheet only while the backend reports sign.templates as
//     available (C-17), and only before anything is added.
// Adding any document moves to step 2.
// M-A12 W1-B: each document shows its page count and a "…" menu (Rename, Move up /
// down, Remove); Rename and reordering apply to documents not uploaded yet.
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Sheet } from '../../components/Sheet';
import type { LimitBanner } from '../../features/inbox/allowance';
import { AddDocumentsSheet } from '../../features/send/AddDocumentsSheet';
import type { SendFlowController, SendFlowState } from '../../features/send/sendFlowController';
import { ErrorText, StepTitle } from '../../features/send/ui';
import type { SendStep } from '../../state/draftStore';
import { useTheme } from '../../theme';

export function DocumentsStep({
  controller,
  state,
  limit,
  templatesEnabled,
  onPicked,
}: {
  readonly controller: SendFlowController;
  readonly state: SendFlowState;
  readonly limit: LimitBanner | null;
  /** The backend's sign.templates availability + permission (never derived here). */
  readonly templatesEnabled: boolean;
  readonly onPicked: (step?: SendStep) => void;
}) {
  const t = useTheme();
  const docs = state.draft?.payload.documents ?? [];
  const isNew = docs.length === 0 && !state.draft?.envelopeId;
  const [sheet, setSheet] = useState(isNew);
  const canUseTemplate = templatesEnabled && isNew;
  const busy = state.busy === 'adding';
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; title: string } | null>(null);
  const mi = docs.findIndex((d) => d.key === menuFor);
  const md = docs[mi];
  const local = (i: number) => (docs[i]?.pendingUpload ?? null) !== null;

  return (
    <View style={styles.body}>
      {limit ? <Banner title={limit.title} body={limit.body} /> : null}
      <StepTitle>What do you want to send?</StepTitle>

      {docs.length > 0 ? (
        <>
          <Text accessibilityRole="header" style={[styles.section, { color: t.color.textSecondary }]}>
            Documents
          </Text>
          <Card>
            {docs.map((d, i) => (
              <View
                key={d.key}
                style={[
                  styles.docRow,
                  i < docs.length - 1 ? { borderBottomWidth: t.size.separatorWidth, borderBottomColor: t.color.separator } : null,
                ]}
              >
                <View style={styles.docText}>
                  <Text numberOfLines={2} style={{ color: t.color.text, fontSize: 16, fontWeight: '600', fontFamily: t.font.family }}>
                    {d.title}
                  </Text>
                  <Text style={{ color: t.color.textSecondary, fontSize: 13, fontFamily: t.font.family }}>
                    {[
                      d.pages ? `${d.pages.length} ${d.pages.length === 1 ? 'page' : 'pages'}` : null,
                      d.pendingUpload ? 'Not uploaded yet' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <Button
                  testID={`doc-menu-${i}`}
                  title="…"
                  variant="text"
                  accessibilityLabel={`More for ${d.title}`}
                  onPress={() => setMenuFor(d.key)}
                />
              </View>
            ))}
          </Card>
        </>
      ) : (
        <Text style={[styles.lead, { color: t.color.textSecondary, fontFamily: t.font.family }]}>
          Scan a document, choose photos or pick a PDF.
        </Text>
      )}

      <Button
        title={docs.length > 0 ? 'Add another document' : 'Add documents'}
        variant={docs.length > 0 ? 'secondary' : 'primary'}
        busy={busy}
        onPress={() => setSheet(true)}
        testID="add-documents"
      />
      {!sheet ? <ErrorText>{state.error}</ErrorText> : null}

      <Sheet visible={md !== undefined && renaming === null} onClose={() => setMenuFor(null)} title={md?.title ?? 'Document'}>
        {md && local(mi) ? (
          <Button testID="doc-rename" title="Rename" variant="secondary" onPress={() => setRenaming({ key: md.key, title: md.title })} />
        ) : null}
        {md && local(mi) && local(mi - 1) ? (
          <Button
            testID="doc-up"
            title="Move up"
            variant="secondary"
            onPress={() => {
              controller.moveDocument(md.key, -1);
              setMenuFor(null);
            }}
          />
        ) : null}
        {md && local(mi) && local(mi + 1) ? (
          <Button
            testID="doc-down"
            title="Move down"
            variant="secondary"
            onPress={() => {
              controller.moveDocument(md.key, 1);
              setMenuFor(null);
            }}
          />
        ) : null}
        {md ? (
          <Button
            testID="doc-remove"
            title="Remove"
            variant="destructive"
            accessibilityLabel={`Remove ${md.title}`}
            onPress={() => {
              setMenuFor(null);
              void controller.removeDocument(md.key);
            }}
          />
        ) : null}
        <Button title="Cancel" variant="text" onPress={() => setMenuFor(null)} />
      </Sheet>
      <Sheet visible={renaming !== null} onClose={() => setRenaming(null)} title="Rename">
        <TextInput
          testID="doc-rename-input"
          value={renaming?.title ?? ''}
          onChangeText={(v) => setRenaming((r) => (r ? { ...r, title: v } : r))}
          accessibilityLabel="Document name"
          autoFocus
          maxLength={200}
          style={[styles.input, { borderColor: t.color.separator, color: t.color.text, backgroundColor: t.color.surface }]}
        />
        <Button
          testID="doc-rename-save"
          title="Save"
          disabled={!renaming?.title.trim()}
          onPress={() => {
            if (renaming) controller.renameDocument(renaming.key, renaming.title);
            setRenaming(null);
            setMenuFor(null);
          }}
        />
      </Sheet>

      <AddDocumentsSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        controller={controller}
        busy={busy}
        error={state.error}
        templatesEnabled={canUseTemplate}
        onAdded={onPicked}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 14, padding: 16 },
  lead: { fontSize: 15, lineHeight: 21 },
  section: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', marginTop: 8, marginLeft: 4 },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 4, paddingVertical: 8 },
  docText: { flex: 1, minWidth: 0, gap: 2 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, fontSize: 16 },
});
