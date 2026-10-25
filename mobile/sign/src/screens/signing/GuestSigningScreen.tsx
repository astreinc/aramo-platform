// Signing from an emailed /s/{token} (sign) or /d/{token} (signed copy) link (directive
// §6; M-A2 §2.1, §2.3; handoff §4.4). The token comes from the in-memory vault, lives in
// memory for this screen only, and travels ONLY on the guest transport — except the
// one-time inbox claim, which is a workspace call by contract (M-A2 §1). A revoked or
// expired token ends the session and shows the recovery copy (C-21); it is never retried.
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useSession } from '../../app/ServicesContext';
import { Button } from '../../components/Button';
import { useSenderContext } from '../../features/inbox/queries';
import { ExecutedCopyView, type ExecutedPart } from '../../features/signing/ExecutedCopyView';
import {
  classifySigningError,
  loadExecutedCopy,
  SIGNING_COPY,
} from '../../features/signing/signingApi';
import { SigningFlow } from '../../features/signing/SigningFlow';
import { useHeaderFinish } from '../../features/signing/useHeaderFinish';
import { useLinkSigning } from '../../features/signing/useLinkSigning';
import type { RootStackParamList } from '../../navigation/types';
import { useAppSwitcherProtection } from '../../security/sensitiveScreen';
import { useTheme } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'GuestSigning'>;

function SignedCopy({
  link,
  onDone,
}: {
  readonly link: ReturnType<typeof useLinkSigning>;
  readonly onDone: () => void;
}) {
  const t = useTheme();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; subject: string; completedAt: string | null; parts: ExecutedPart[] }
    | { kind: 'failed'; message: string }
  >(link.session ? { kind: 'loading' } : { kind: 'failed', message: SIGNING_COPY.ended });
  useEffect(() => {
    const s = link.session;
    if (!s) return;
    loadExecutedCopy(s).then(
      (c) =>
        setState({
          kind: 'ready',
          subject: c.subject,
          completedAt: c.completed_at,
          parts: [
            ...c.documents.map((d, i) => ({
              key: `doc-${i}`,
              title: d.title,
              base64: d.executed_base64,
            })),
            ...(c.certificate_base64
              ? [{ key: 'certificate', title: 'Certificate', base64: c.certificate_base64 }]
              : []),
          ],
        }),
      (e: unknown) => {
        const k = classifySigningError(e);
        setState({
          kind: 'failed',
          message:
            k === 'network'
              ? 'Couldn’t load the signed copy. Check your connection and try again.'
              : SIGNING_COPY.ended,
        });
      },
    );
  }, [link.session]);
  if (state.kind === 'loading')
    return (
      <View style={[styles.center, { backgroundColor: t.color.screen }]}>
        <ActivityIndicator color={t.color.accent} />
      </View>
    );
  if (state.kind === 'failed')
    return (
      <View style={[styles.center, { backgroundColor: t.color.screen, padding: 24, gap: 16 }]}>
        <Text style={{ color: t.color.text, fontSize: 17, textAlign: 'center' }}>
          {state.message}
        </Text>
        <Button title="Done" variant="secondary" onPress={onDone} />
      </View>
    );
  return (
    <ExecutedCopyView subject={state.subject} completedAt={state.completedAt} parts={state.parts} />
  );
}

export function GuestSigningScreen({ route, navigation }: Props) {
  const link = useLinkSigning(route.params.handle);
  const { status } = useSession();
  const signedIn = status === 'signedIn';
  const ctx = useSenderContext(signedIn);
  const setHeaderFinish = useHeaderFinish();
  useAppSwitcherProtection(true);
  useEffect(() => {
    navigation.setOptions({
      title: route.params.mode === 'sign' ? 'Review and sign' : 'Signed copy',
    });
  }, [navigation, route.params.mode]);

  const done = () =>
    navigation.canGoBack()
      ? navigation.goBack()
      : navigation.navigate(signedIn ? 'Main' : 'SignIn');

  if (route.params.mode === 'download') return <SignedCopy link={link} onDone={done} />;
  return (
    <SigningFlow
      session={link.session}
      signerName={signedIn ? (ctx.data?.user.display_name ?? '') : ''}
      signedIn={signedIn}
      {...(signedIn ? { onClaim: link.claim } : {})}
      onDone={done}
      onHeaderFinish={setHeaderFinish}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
