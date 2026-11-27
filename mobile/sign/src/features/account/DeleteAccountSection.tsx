// Aramo-Sign-Mobile-Amendment-M-A7 §3.3 — Account → "Delete account / Request
// deletion", shown prominently for every account type. Replaces the Personal
// "Close account" (closing alone is not deletion, §3.2). Typing DELETE confirms; the
// sheet then shows the request ID, its status and what is kept and why. When the
// session has ended (Personal, or a completed request) the app signs out at once (which also
// wipes the temporary documents, M-A7 §4 R-7) and the signed-out screen shows the receipt
// (APP-DELETED-1 A1: the server ends every session, so the sheet could not stay).
// Apple Go-Live R-8: for an Apple-linked account the app first asks Apple for a fresh
// authorization code so sign-service can revoke Apple's tokens. Best effort: whatever
// happens there, the deletion request is sent.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { useServices } from '../../app/ServicesContext';
import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { useTheme } from '../../theme';

import { DeletionReceipt } from './DeletionReceipt';
import { setDeletionReceipt } from './deletionReceiptStore';
import {
  DELETE_ACCOUNT_URL,
  deleteConfirmed,
  deletionCopy,
  loadPrivacyRequests,
  openDeletion,
  requestDeletion,
  signOutAfter,
  type PrivacyRequest,
} from './privacy';

const privacyKey = ['sign', 'me', 'privacy-requests'] as const;

export function DeleteAccountSection({
  personal,
  online,
  appleLinked = false,
}: {
  personal: boolean;
  online: boolean;
  /** The user signs in with Apple: revoke Apple's tokens before deleting (R-8). */
  appleLinked?: boolean;
}) {
  const t = useTheme();
  const qc = useQueryClient();
  const { workspace, signOut, revokeApple } = useServices();
  const requests = useQuery({ queryKey: privacyKey, queryFn: () => loadPrivacyRequests(workspace) });
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PrivacyRequest | null>(null);
  const existing = openDeletion(requests.data ?? []);
  const shown = result ?? existing;
  const copy = deletionCopy(personal);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // While still signed in (the revoke route needs the session). Never blocks deletion.
      if (personal && appleLinked) await revokeApple().catch(() => false);
      const r = await requestDeletion(workspace);
      // APP-DELETED-1 A1 — the server has already ended every session: keep the receipt, sign
      // out here (no refetch with the ended session), and the signed-out screen shows it.
      if (signOutAfter(r, personal)) {
        setDeletionReceipt(r);
        setOpen(false);
        void signOut();
        return;
      }
      setResult(r);
      void qc.invalidateQueries({ queryKey: privacyKey });
    } catch (e) {
      setError(isApiError(e) ? refusalMessage(e) : 'Couldn’t send the request. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function done(): void {
    setOpen(false);
    if (result !== null && signOutAfter(result, personal)) void signOut();
  }

  const text = { color: t.color.textSecondary, fontSize: 15, lineHeight: 21 } as const;
  return (
    <View style={styles.pad} testID="delete-account-section">
      <Button
        testID="delete-account"
        title={existing ? 'Deletion requested — view status' : personal ? 'Delete account' : 'Request deletion'}
        variant="destructive"
        disabled={!online && !existing}
        onPress={() => setOpen(true)}
      />
      <Sheet visible={open} onClose={done} title={shown ? 'Your deletion request' : copy.title}>
        {shown ? (
          <DeletionReceipt request={shown} doneLabel={result && signOutAfter(result, personal) ? 'Done — sign out' : 'Done'} onDone={done} />
        ) : (
          <View style={{ gap: 8 }}>
            {copy.points.map((p) => (
              <Text key={p} style={text}>
                • {p}
              </Text>
            ))}
            <Text style={text}>Type DELETE to confirm.</Text>
            <TextInput
              testID="delete-confirm-input"
              value={typed}
              onChangeText={setTyped}
              autoCapitalize="characters"
              autoCorrect={false}
              accessibilityLabel="Type DELETE to confirm"
              style={[styles.input, { borderColor: t.color.separator, color: t.color.text, backgroundColor: t.color.surface }]}
            />
            {error ? (
              <Text accessibilityRole="alert" style={{ color: t.color.destructive }}>
                {error}
              </Text>
            ) : null}
            <Button
              testID="delete-account-confirm"
              title={copy.button}
              variant="destructive"
              disabled={!deleteConfirmed(typed) || !online}
              busy={busy}
              onPress={() => void submit()}
            />
            <Button
              title="Use the web page instead"
              variant="text"
              onPress={() => void WebBrowser.openBrowserAsync(DELETE_ACCOUNT_URL).catch(() => undefined)}
            />
            <Button title="Cancel" variant="text" onPress={() => setOpen(false)} />
          </View>
        )}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { marginHorizontal: 16, marginTop: 24 },
  input: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 17, minHeight: 48 },
});
