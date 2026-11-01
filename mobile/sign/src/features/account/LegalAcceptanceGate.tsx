// ToS v2.0 (PO 2026-11-01) — the blocking legal acceptance after sign-in. When the backend
// (GET /v1/sign/legal/status) lists current documents this user has not accepted (Personal:
// the Personal documents; Business: the Aramo Sign Terms of Service in effect), a full-screen
// modal lists them (each opens in the browser), with an unticked box; the user accepts
// (POST /v1/sign/legal/accept, the exact versions shown) or signs out. It covers the
// navigator, so an open screen keeps its state. The server decides what is pending and
// refuses sending while anything is; a failed status read does not block the app (the
// send refusal still holds), the same rule as the web workspace.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { useServices } from '../../app/ServicesContext';
import { Button } from '../../components/Button';
import { useTheme } from '../../theme';
import { useOnline } from '../inbox/queries';
import { CheckRow } from '../inbox/ui';
import { LEGAL_STATUS_KEY, acceptPending, loadLegalStatus, type LegalStatus } from './legal';

function open(url: string): void {
  void WebBrowser.openBrowserAsync(url).catch(() => undefined);
}

export function LegalAcceptanceGate() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const online = useOnline();
  const { workspace, signOut } = useServices();
  const status = useQuery({ queryKey: LEGAL_STATUS_KEY, queryFn: () => loadLegalStatus(workspace) });
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = Array.isArray(status.data?.pending) ? status.data.pending : [];
  if (pending.length === 0) return null;

  async function accept(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next: LegalStatus = await acceptPending(workspace, pending);
      setAgreed(false);
      qc.setQueryData(LEGAL_STATUS_KEY, next);
    } catch (e) {
      setError(isApiError(e) ? refusalMessage(e) : 'We couldn’t record your acceptance. Try again.');
      void status.refetch();
    } finally {
      setBusy(false);
    }
  }

  const text = { color: t.color.textSecondary, fontSize: 15, lineHeight: 21 } as const;
  return (
    <Modal visible animationType="slide" onRequestClose={() => undefined} testID="legal-gate">
      <ScrollView
        style={{ flex: 1, backgroundColor: t.color.screen }}
        contentContainerStyle={[styles.body, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
      >
        <Text accessibilityRole="header" style={{ color: t.color.text, fontSize: 22, fontWeight: '700' }}>
          Review the updated terms
        </Text>
        <Text style={text}>Before you continue, read and accept the current versions of these documents.</Text>
        <View style={{ gap: 4 }} testID="legal-gate-docs">
          {pending.map((p) => (
            <Button
              key={`${p.key}@${p.version}`}
              variant="text"
              title={`${p.title} (version ${p.version})`}
              accessibilityHint="Opens the document in your browser"
              onPress={() => open(p.url)}
              style={{ alignSelf: 'flex-start' }}
              testID={`legal-gate-doc-${p.key}`}
            />
          ))}
        </View>
        <CheckRow
          checked={agreed}
          onToggle={() => setAgreed((v) => !v)}
          accessibilityLabel="I have read and agree to the documents above"
          testID="legal-gate-check"
        >
          <Text style={{ color: t.color.text, fontSize: 15 }}>I have read and agree to the documents above.</Text>
        </CheckRow>
        {error !== null ? (
          <Text testID="legal-gate-error" style={{ color: t.color.destructive, fontSize: 15 }}>
            {error}
          </Text>
        ) : null}
        <Button
          title="Accept and continue"
          disabled={!agreed || !online}
          busy={busy}
          onPress={() => void accept()}
          testID="legal-gate-accept"
        />
        <Button title="Sign out" variant="secondary" onPress={() => void signOut()} testID="legal-gate-sign-out" />
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  body: { gap: 16, paddingHorizontal: 24 },
});
