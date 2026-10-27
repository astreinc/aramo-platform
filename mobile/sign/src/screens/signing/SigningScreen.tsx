// Inbox signing for a claimed recipient (handoff §4.4; directive §6; M-A2 §2.2). The
// route's `envelopeId` is the INBOX ITEM id (GET /v1/sign/inbox `id`): the inbox never
// exposes the sender's envelope id (§4.6). Each visit asks the server for a fresh,
// revalidated 30-minute session (POST /v1/sign/inbox/:id/sign on the workspace client),
// opens it on the guest transport and discards it on exit. Refusals show the directive
// §7 copy; nothing is retried with an ended token.
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import type { GuestSigningSession } from '../../api/guestSigningClient';
import { useServices } from '../../app/ServicesContext';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import {
  findInboxItem,
  signedCopyToken,
  startInboxSigning,
} from '../../features/inbox/inboxSigning';
import { signKeys, useInbox, useOnline, useSenderContext } from '../../features/inbox/queries';
import { SigningFlow } from '../../features/signing/SigningFlow';
import { useHeaderFinish } from '../../features/signing/useHeaderFinish';
import { stashGuestToken } from '../../links/guestTokenVault';
import type { RootStackParamList } from '../../navigation/types';
import { useAppSwitcherProtection } from '../../security/sensitiveScreen';
import { useTheme } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Signing'>;

export function SigningScreen({ route, navigation }: Props) {
  const inboxItemId = route.params.envelopeId;
  const t = useTheme();
  const toast = useToast();
  const qc = useQueryClient();
  const online = useOnline();
  const { workspace, guest } = useServices();
  const inbox = useInbox();
  const ctx = useSenderContext();
  const setHeaderFinish = useHeaderFinish();
  const item = findInboxItem(inbox.data, inboxItemId);
  const [start, setStart] = useState<
    | { kind: 'starting' }
    | { kind: 'ready'; session: GuestSigningSession }
    | { kind: 'refused'; message: string }
  >({ kind: 'starting' });
  const [attempt, setAttempt] = useState(0);
  useAppSwitcherProtection(true);

  useEffect(() => {
    let live = true;
    let opened: GuestSigningSession | null = null;
    startInboxSigning(workspace, guest, inboxItemId).then(
      (r) => {
        if (r.kind === 'session') {
          opened = r.session;
          if (live) setStart({ kind: 'ready', session: r.session });
          else r.session.discard();
        } else if (live) setStart({ kind: 'refused', message: r.message });
      },
      () => {
        if (live)
          setStart({
            kind: 'refused',
            message: 'Couldn’t open this envelope. Check your connection and try again.',
          });
      },
    );
    return () => {
      live = false;
      opened?.discard();
    };
  }, [workspace, guest, inboxItemId, attempt]);

  const done = () => {
    void qc.invalidateQueries({ queryKey: signKeys.inbox });
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Main');
  };

  async function viewCertificate(): Promise<void> {
    try {
      const token = await signedCopyToken(workspace, inboxItemId);
      if (!token) return;
      navigation.navigate('GuestSigning', { handle: stashGuestToken(token), mode: 'download' });
    } catch {
      toast.show('The signed copy isn’t ready yet.');
    }
  }

  if (start.kind === 'starting')
    return (
      <View style={[styles.center, { backgroundColor: t.color.screen }]}>
        <ActivityIndicator color={t.color.accent} accessibilityLabel="Opening" />
      </View>
    );
  if (start.kind === 'refused')
    return (
      <View
        style={[styles.center, styles.pad, { backgroundColor: t.color.screen }]}
        testID="inbox-sign-refused"
      >
        <Text
          accessibilityRole="alert"
          style={{ color: t.color.text, fontSize: 17, lineHeight: 24, textAlign: 'center' }}
        >
          {start.message}
        </Text>
        <Button
          title="Try again"
          variant="secondary"
          disabled={!online}
          onPress={() => {
            setStart({ kind: 'starting' });
            setAttempt((a) => a + 1);
          }}
        />
        <Button title="Done" onPress={done} />
      </View>
    );
  return (
    <SigningFlow
      session={start.session}
      senderName={item?.from ?? null}
      subject={item?.subject ?? null}
      // Announcements and the adopt sheet's default only: a Name field is never
      // filled from the signed-in account (M-A6 §2.2) — the server fills a profile
      // name, and the signer types any other.
      signerName={ctx.data?.user.display_name ?? ''}
      signedIn
      onViewCertificate={() => void viewCertificate()}
      onDone={done}
      onHeaderFinish={setHeaderFinish}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pad: { padding: 24, gap: 16 },
});
