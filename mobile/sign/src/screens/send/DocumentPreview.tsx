// PO 2026-11-18 (DocuSign comparison) — preview an added document before going on: every
// page, full screen, Close returns to the Documents step with nothing changed. The bytes
// come from the Send flow (the encrypted device copy, or the server's copy once uploaded);
// nothing is written.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '../../components/Button';
import { PdfPages } from '../../features/signing/PdfPages';
import { useTheme } from '../../theme';

export function DocumentPreview({
  doc,
  load,
  onClose,
}: {
  /** The document to show, or null when closed. */
  readonly doc: { readonly key: string; readonly title: string } | null;
  readonly load: (key: string) => Promise<{ base64: string }>;
  readonly onClose: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [base64, setBase64] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const key = doc?.key ?? null;

  useEffect(() => {
    setBase64(null);
    setFailed(false);
    if (key === null) return undefined;
    let live = true;
    load(key).then(
      (a) => live && setBase64(a.base64),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
    // Load once per document opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <Modal visible={doc !== null} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={[styles.fill, { backgroundColor: t.color.screen, paddingTop: insets.top }]} testID="document-preview">
        <View style={styles.header}>
          <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: t.color.text, fontFamily: t.font.family }]}>
            {doc?.title ?? ''}
          </Text>
          <Button title="Close" variant="text" onPress={onClose} testID="document-preview-close" />
        </View>
        {failed ? (
          <Text style={[styles.note, { color: t.color.textSecondary }]}>The document couldn’t be shown. Check your connection and try again.</Text>
        ) : base64 === null ? (
          <ActivityIndicator color={t.color.accent} accessibilityLabel="Loading the document" style={styles.note} />
        ) : (
          <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 24 + insets.bottom }}>
            <PdfPages source={{ kind: 'base64', base64 }} width={Math.max(200, width - 24)} title={doc?.title ?? 'Document'} onError={() => setFailed(true)} />
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  title: { flex: 1, fontSize: 17, fontWeight: '600' },
  note: { margin: 24, textAlign: 'center' },
});
