// Aramo-Sign-Mobile-Amendment-M-A8 §2.1/§2.2 — Account for a Business user (anyone but
// the tenant_owner of a PERSONAL tenant): no self-service account deletion. The
// organization manages the account; the user keeps a clearly accessible "Privacy
// requests" entry for ACCESS, EXPORT, CORRECTION and DELETION of eligible personal
// information. The server decides everything; a DELETION is referred to the
// organization and the Aramo privacy team and is never executed by the app. The sheet
// shows the request ID and status.
import { useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { useServices } from '../../app/ServicesContext';
import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { ARAMO_SIGN_IDENTITY } from '../../config/identity';
import { useTheme } from '../../theme';

import {
  BUSINESS_MANAGED_COPY,
  DELETE_ACCOUNT_URL,
  PRIVACY_REQUEST_OPTIONS,
  deleteConfirmed,
  requestPrivacy,
  type PrivacyRequest,
  type PrivacyRequestType,
} from './privacy';

const privacyKey = ['sign', 'me', 'privacy-requests'] as const;

export function PrivacyRequestsSection({ online }: { online: boolean }) {
  const t = useTheme();
  const qc = useQueryClient();
  const { workspace } = useServices();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<PrivacyRequestType | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PrivacyRequest | null>(null);

  function close(): void {
    setOpen(false);
    setType(null);
    setTyped('');
    setError(null);
    setResult(null);
  }

  async function submit(chosen: PrivacyRequestType): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await requestPrivacy(workspace, chosen);
      setResult(r);
      void qc.invalidateQueries({ queryKey: privacyKey });
    } catch (e) {
      setError(isApiError(e) ? refusalMessage(e) : 'Couldn’t send the request. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const text = { color: t.color.textSecondary, fontSize: 15, lineHeight: 21 } as const;
  const option = PRIVACY_REQUEST_OPTIONS.find((o) => o.type === type) ?? null;
  return (
    <View style={styles.pad} testID="privacy-requests-section">
      <Text testID="business-managed-copy" style={[text, { marginBottom: 12 }]}>
        {BUSINESS_MANAGED_COPY}
      </Text>
      <Button testID="privacy-requests" title="Privacy requests" variant="secondary" disabled={!online} onPress={() => setOpen(true)} />
      <Sheet visible={open} onClose={close} title={result ? 'Your privacy request' : option ? option.title : 'Privacy requests'}>
        {result ? (
          <View testID="privacy-request-result" style={{ gap: 6 }}>
            <Text style={text}>Request ID</Text>
            <Text testID="privacy-request-reference" selectable style={{ color: t.color.text, fontSize: 17, fontWeight: '600' }}>
              {result.reference}
            </Text>
            <Text testID="privacy-request-status" style={text}>
              Status: {result.status_label}
            </Text>
            {result.organization_decides ? <Text style={text}>{result.organization_decides}</Text> : null}
            {result.retained.length > 0 ? <Text style={text}>What we keep, and why:</Text> : null}
            {result.retained.map((r) => (
              <Text key={r.key} style={text}>
                • {r.label}. {r.why}
              </Text>
            ))}
            <Text style={text}>
              Keep the request ID. You can check it any time at {DELETE_ACCOUNT_URL.replace(/^https:\/\//, '')} or ask {ARAMO_SIGN_IDENTITY.privacyEmail}.
            </Text>
            <Button testID="privacy-request-done" title="Done" onPress={close} />
          </View>
        ) : option ? (
          <View style={{ gap: 8 }}>
            <Text style={text}>{option.detail}</Text>
            {option.type === 'DELETION' ? (
              <>
                <Text style={text}>Type DELETE to confirm.</Text>
                <TextInput
                  testID="privacy-delete-confirm-input"
                  value={typed}
                  onChangeText={setTyped}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  accessibilityLabel="Type DELETE to confirm"
                  style={[styles.input, { borderColor: t.color.separator, color: t.color.text, backgroundColor: t.color.surface }]}
                />
              </>
            ) : null}
            {error ? (
              <Text accessibilityRole="alert" style={{ color: t.color.destructive }}>
                {error}
              </Text>
            ) : null}
            <Button
              testID="privacy-request-send"
              title="Send request"
              disabled={!online || (option.type === 'DELETION' && !deleteConfirmed(typed))}
              busy={busy}
              onPress={() => void submit(option.type)}
            />
            <Button title="Back" variant="text" onPress={() => setType(null)} />
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <Text style={text}>Ask the Aramo privacy team about your personal information. Your account stays with your organization.</Text>
            {PRIVACY_REQUEST_OPTIONS.map((o) => (
              <Button key={o.type} testID={`privacy-request-${o.type}`} title={o.title} variant="secondary" onPress={() => setType(o.type)} />
            ))}
            <Button
              title="Use the web page instead"
              variant="text"
              onPress={() => void WebBrowser.openBrowserAsync(DELETE_ACCOUNT_URL).catch(() => undefined)}
            />
            <Button title="Cancel" variant="text" onPress={close} />
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
