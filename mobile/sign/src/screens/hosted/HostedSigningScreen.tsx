// Locked hosted (in-person) signing (M-A5 §3.3, §3.4). Started by the host from the
// envelope detail (startHosted.ts) with a HOSTED session whose token waits in the
// in-memory vault; this screen takes it once, uses it ONLY on the guest signing
// transport (no workspace credentials), and discards it when the signing part ends.
//
//   1. Hand-off: "Give the device to {name}".
//   2. The signer's own signing flow. Consent asks them to type their name, sent as
//      `attested_name`; the host's biometric "confirm signing" and saved signatures are
//      never offered (the device is the host's, the signer is not).
//   3. "Hand the device back" after finish / decline / expiry / cancel. Leaving needs
//      the host's device authentication (biometrics or device passcode). A device with
//      neither signs the workspace out instead, so the host signs in again (hostAuth.ts).
//
// While the mode is active: no back gesture, no hardware back, no header back, the tab
// bar and side menu are covered (full-screen modal), and deep links / pushes don't
// navigate (hostedLock.ts).
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, StyleSheet, Text, View } from 'react-native';

import { useServices } from '../../app/ServicesContext';
import { Button } from '../../components/Button';
import {
  authenticateHost,
  deviceHostAuth,
  type HostAuthDeps,
} from '../../features/hosted/hostAuth';
import { setHostedLocked } from '../../features/hosted/hostedLock';
import {
  HOSTED_COPY,
  hostedReducer,
  initialHostedState,
  isLocked,
  msUntil,
} from '../../features/hosted/hostedModel';
import { signKeys } from '../../features/inbox/queries';
import { SigningFlow } from '../../features/signing/SigningFlow';
import { useHeaderFinish } from '../../features/signing/useHeaderFinish';
import type { RootStackParamList } from '../../navigation/types';
import { useAppSwitcherProtection } from '../../security/sensitiveScreen';
import { useGuestSigningSession } from '../../signing/useGuestSigningSession';
import { useTheme } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'HostedSigning'> & {
  /** Tests inject the device authentication. */
  readonly hostAuth?: HostAuthDeps;
};

export function HostedSigningScreen({ route, navigation, hostAuth = deviceHostAuth }: Props) {
  const { handle, signerName, envelopeId, expiresAt } = route.params;
  const t = useTheme();
  const qc = useQueryClient();
  const { signOut } = useServices();
  const session = useGuestSigningSession(handle);
  const [state, dispatch] = useReducer(hostedReducer, initialHostedState);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const [signingOut, setSigningOut] = useState(false);
  const setHeaderFinish = useHeaderFinish();
  useAppSwitcherProtection(true);

  // The process-wide lock (deep links and pushes don't navigate while it's set).
  useEffect(() => {
    setHostedLocked(true);
    return () => setHostedLocked(false);
  }, []);

  // No way back into the workspace while locked: stack removal and hardware back.
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e) => {
        if (isLocked(stateRef.current)) e.preventDefault();
      }),
    [navigation],
  );
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      dispatch({ type: 'BACK' });
      return isLocked(stateRef.current);
    });
    return () => sub.remove();
  }, []);

  // The session's own end (30 minutes at most, M-A5 §3.2).
  useEffect(() => {
    const id = setTimeout(() => dispatch({ type: 'EXPIRED' }), msUntil(expiresAt));
    return () => clearTimeout(id);
  }, [expiresAt]);

  // Once the signing part is over the token is forgotten (an authentication attempt that
  // fails returns to where it was, so the session lives on until hand-back).
  const signingOver = state.phase === 'handback' || state.phase === 'exited';
  useEffect(() => {
    if (signingOver) {
      session?.discard();
      setHeaderFinish(null);
    }
  }, [signingOver, session, setHeaderFinish]);

  // Unlocked: back to the envelope, refreshed.
  useEffect(() => {
    if (state.phase !== 'exited') return;
    setHostedLocked(false);
    void qc.invalidateQueries({ queryKey: signKeys.detail(envelopeId) });
    void qc.invalidateQueries({ queryKey: signKeys.events(envelopeId) });
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('EnvelopeDetail', { envelopeId });
  }, [state.phase, qc, envelopeId, navigation]);

  const exit = useCallback(async () => {
    dispatch({ type: 'REQUEST_EXIT' });
    const r = await authenticateHost(hostAuth, HOSTED_COPY.authPrompt);
    if (r === 'ok') {
      dispatch({ type: 'AUTH_OK' });
      return;
    }
    if (r === 'failed') {
      dispatch({ type: 'AUTH_FAILED', message: HOSTED_COPY.authFailed });
      return;
    }
    // No passcode and no biometrics: leaving signs the workspace out (re-sign-in).
    Alert.alert('Sign out to leave', HOSTED_COPY.noDeviceAuth, [
      {
        text: 'Cancel',
        style: 'cancel',
        onPress: () => dispatch({ type: 'AUTH_FAILED', message: '' }),
      },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          setSigningOut(true);
          session?.discard();
          void signOut();
        },
      },
    ]);
  }, [hostAuth, session, signOut]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'Signing in person',
      gestureEnabled: false,
      headerBackVisible: false,
      headerLeft:
        state.phase === 'signing'
          ? () => (
              <Button
                title="Exit"
                variant="text"
                testID="hosted-exit"
                onPress={() => void exit()}
              />
            )
          : () => null,
    });
  }, [navigation, state.phase, exit]);

  if (state.phase === 'exited' || signingOut) {
    return (
      <View style={[styles.center, { backgroundColor: t.color.screen }]}>
        <ActivityIndicator color={t.color.accent} accessibilityLabel="Leaving in-person signing" />
      </View>
    );
  }

  if (state.phase === 'signing' || (state.phase === 'verifying' && state.resume === 'signing')) {
    return (
      <SigningFlow
        session={session}
        signerName={signerName}
        signedIn={false}
        attestName
        deviceConfirm={false}
        onDone={() => dispatch({ type: 'SIGNER_DONE' })}
        onHeaderFinish={setHeaderFinish}
      />
    );
  }

  const handoff =
    state.phase === 'handoff' || (state.phase === 'verifying' && state.resume === 'handoff');
  const end = state.end ?? 'cancelled';
  return (
    <View
      style={[styles.page, { backgroundColor: t.color.screen }]}
      testID={`hosted-page-${state.phase}`}
    >
      <Text
        accessibilityRole="header"
        style={[styles.title, { color: t.color.text, fontFamily: t.font.family }]}
      >
        {handoff ? HOSTED_COPY.handoffTitle(signerName) : HOSTED_COPY.handbackTitle}
      </Text>
      <Text style={[styles.body, { color: t.color.textSecondary, fontFamily: t.font.family }]}>
        {handoff ? HOSTED_COPY.handoffBody : HOSTED_COPY.handbackBody[end]}
      </Text>
      {state.authError ? (
        <Text
          accessibilityRole="alert"
          style={{ color: t.color.destructive, fontSize: 15, textAlign: 'center' }}
        >
          {state.authError}
        </Text>
      ) : null}
      {handoff ? (
        <>
          <Button
            title="Start signing"
            testID="hosted-begin"
            disabled={!session}
            onPress={() => dispatch({ type: 'BEGIN' })}
          />
          <Button
            title="Cancel in-person signing"
            variant="text"
            testID="hosted-cancel"
            onPress={() => void exit()}
          />
        </>
      ) : (
        <Button
          title={HOSTED_COPY.exitButton}
          testID="hosted-handback"
          busy={state.phase === 'verifying'}
          accessibilityHint="Asks for your device passcode or biometrics"
          onPress={() => void exit()}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  page: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  title: { fontSize: 26, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 17, lineHeight: 24, textAlign: 'center' },
});
