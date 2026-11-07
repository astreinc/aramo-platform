// Auth-gated root stack (handoff §2). Signed out: Sign in + native Personal signup
// (M-A11) + guest signing. Signed in:
// tabs (Home · Agreements) + the side-menu screens (Notifications, Account, Templates) +
// detail/signing/viewer/send + (M-A12) Sign a document, Tasks, Plans and My profile. Guest signing is reachable in both states.
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Modal, View } from 'react-native';

import { useServices, useSession } from '../app/ServicesContext';
import { biometricCapability, biometricUnlockPref, shouldRelock } from '../auth/biometric';
import { LegalAcceptanceGate } from '../features/account/LegalAcceptanceGate';
import { SignupScreen } from '../features/signup/SignupScreen';
import { setPendingTarget } from '../links/pendingTarget';
import { AccountScreen } from '../screens/account/AccountScreen';
import { DocumentViewerScreen } from '../screens/documents/DocumentViewerScreen';
import { EnvelopeDetailScreen } from '../screens/envelope/EnvelopeDetailScreen';
import { HostedSigningScreen } from '../screens/hosted/HostedSigningScreen';
import { ReceivedEnvelopeScreen } from '../screens/envelope/ReceivedEnvelopeScreen';
import { NotificationsScreen } from '../screens/notifications/NotificationsScreen';
import { PlansScreen } from '../screens/plans/PlansScreen';
import { ProfileScreen } from '../screens/profile/ProfileScreen';
import { SelfSignScreen } from '../screens/selfSign/SelfSignScreen';
import { SendFlowScreen } from '../screens/send/SendFlowScreen';
import { TasksScreen } from '../screens/tasks/TasksScreen';
import { SignInScreen } from '../screens/signIn/SignInScreen';
import { GuestSigningScreen } from '../screens/signing/GuestSigningScreen';
import { SigningScreen } from '../screens/signing/SigningScreen';
import { TemplatesScreen } from '../screens/templates/TemplatesScreen';
import { UnlockScreen } from '../screens/unlock/UnlockScreen';
import { useTheme } from '../theme';
import { MainTabs } from './MainTabs';
import { navigationRef } from './navigationRef';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

/** On session expiry, remember an authenticated screen so sign-in returns to it. */
function useKeepTargetOnExpiry(): void {
  const snap = useSession();
  const prev = useRef(snap.status);
  useEffect(() => {
    if (
      prev.current === 'signedIn' &&
      snap.status === 'signedOut' &&
      snap.cause === 'expired' &&
      navigationRef.isReady()
    ) {
      const route = navigationRef.getCurrentRoute();
      if (route?.name === 'EnvelopeDetail')
        setPendingTarget({
          kind: 'envelope',
          envelopeId: (route.params as { envelopeId: string }).envelopeId,
        });
      if (route?.name === 'Signing')
        setPendingTarget({
          kind: 'inbox-sign',
          envelopeId: (route.params as { envelopeId: string }).envelopeId,
        });
    }
    prev.current = snap.status;
  }, [snap]);
}

type LockState = 'checking' | 'locked' | 'open';

/** Optional biometric unlock, decided once per signed-in session (M-A1 §4: local only). */
function useBiometricLock(sessionKey: string | null): [LockState, () => void] {
  const { kv } = useServices();
  const [state, setState] = useState<{ key: string; locked: boolean } | null>(null);
  useEffect(() => {
    if (sessionKey === null) return undefined;
    let live = true;
    void (async () => {
      const on = await biometricUnlockPref.get(kv).catch(() => false);
      const cap = on ? await biometricCapability().catch(() => null) : null;
      if (live)
        setState((s) =>
          s?.key === sessionKey ? s : { key: sessionKey, locked: Boolean(on && cap?.available) },
        );
    })();
    return () => {
      live = false;
    };
  }, [sessionKey, kv]);
  const lock: LockState =
    sessionKey === null
      ? 'open'
      : state?.key !== sessionKey
        ? 'checking'
        : state.locked
          ? 'locked'
          : 'open';
  return [lock, () => sessionKey !== null && setState({ key: sessionKey, locked: false })];
}

/**
 * Unlock again when the app returns from the background after RELOCK_AFTER_MS (unlock
 * on). Covers the app instead of replacing the stack, so an open screen keeps its state.
 * Only 'background' counts: the Face ID prompt itself makes the app 'inactive'.
 */
function useRelockOnResume(active: boolean): [boolean, () => void] {
  const { kv } = useServices();
  const [relocked, setRelocked] = useState(false);
  useEffect(() => {
    if (!active) return undefined;
    let backgroundedAt: number | null = null;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        backgroundedAt ??= Date.now();
        return;
      }
      if (next !== 'active') return;
      const due = shouldRelock(backgroundedAt, Date.now());
      backgroundedAt = null;
      if (!due) return;
      void (async () => {
        const on = await biometricUnlockPref.get(kv).catch(() => false);
        const cap = on ? await biometricCapability().catch(() => null) : null;
        if (on && cap?.available) setRelocked(true);
      })();
    });
    return () => sub.remove();
  }, [active, kv]);
  return [active && relocked, () => setRelocked(false)];
}

export function RootNavigator() {
  const t = useTheme();
  const snap = useSession();
  useKeepTargetOnExpiry();
  const [lock, unlock] = useBiometricLock(
    snap.status === 'signedIn' ? (snap.deviceSessionId ?? 'session') : null,
  );
  const [relocked, unlockResumed] = useRelockOnResume(
    snap.status === 'signedIn' && lock === 'open',
  );

  if (snap.status === 'restoring' || lock === 'checking') {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: t.color.screen,
        }}
      >
        <ActivityIndicator color={t.color.accent} />
      </View>
    );
  }
  return (
    <>
      <Stack.Navigator
        screenOptions={{
          headerTintColor: t.color.accent,
          contentStyle: { backgroundColor: t.color.screen },
        }}
      >
        {snap.status === 'signedOut' ? (
          <>
            <Stack.Screen name="SignIn" component={SignInScreen} options={{ headerShown: false }} />
            <Stack.Screen
              name="Signup"
              component={SignupScreen}
              options={{ title: 'Create a free account', headerBackTitle: 'Sign in' }}
            />
          </>
        ) : lock === 'locked' ? (
          <Stack.Screen name="Unlock" options={{ headerShown: false }}>
            {() => <UnlockScreen onUnlocked={unlock} />}
          </Stack.Screen>
        ) : (
          <>
            <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
            {/* Side-menu screens: each draws its own "‹ Home" back link (M-A4 §1.5). */}
            <Stack.Screen
              name="Notifications"
              component={NotificationsScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Account"
              component={AccountScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Templates"
              component={TemplatesScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="EnvelopeDetail"
              component={EnvelopeDetailScreen}
              options={{ title: '', headerBackTitle: 'Agreements' }}
            />
            <Stack.Screen
              name="ReceivedEnvelope"
              component={ReceivedEnvelopeScreen}
              options={{ title: '', headerBackTitle: 'Agreements' }}
            />
            <Stack.Screen
              name="Signing"
              component={SigningScreen}
              options={{ title: 'Review and sign' }}
            />
            <Stack.Screen
              name="DocumentViewer"
              component={DocumentViewerScreen}
              options={{ title: 'Documents' }}
            />
            <Stack.Screen
              name="SendFlow"
              component={SendFlowScreen}
              options={{ presentation: 'fullScreenModal', title: 'New envelope' }}
            />
            {/* M-A12 W1: Sign a document, Tasks, Plans and the Sign profile. */}
            <Stack.Screen
              name="SelfSign"
              component={SelfSignScreen}
              // M-A14 — Sign Document draws its own headers (a06, a08).
              options={{ title: 'Sign Document', headerShown: false }}
            />
            <Stack.Screen name="Tasks" component={TasksScreen} options={{ title: 'Tasks', headerBackTitle: 'Home' }} />
            <Stack.Screen name="Plans" component={PlansScreen} options={{ title: 'Plans', headerBackTitle: 'Back' }} />
            <Stack.Screen
              name="Profile"
              component={ProfileScreen}
              options={{ title: 'My profile', headerBackTitle: 'Account' }}
            />
            {/* Locked hosted (in-person) signing: covers tabs and side menu (M-A5 §3.3). */}
            <Stack.Screen
              name="HostedSigning"
              component={HostedSigningScreen}
              options={{
                presentation: 'fullScreenModal',
                title: 'Signing in person',
                gestureEnabled: false,
                headerBackVisible: false,
              }}
            />
          </>
        )}
        <Stack.Screen
          name="GuestSigning"
          component={GuestSigningScreen}
          options={{ title: 'Review and sign', presentation: 'fullScreenModal' }}
        />
      </Stack.Navigator>
      {/* ToS v2.0 — blocking acceptance of the current legal documents after sign-in (and unlock). */}
      {snap.status === 'signedIn' && lock === 'open' ? <LegalAcceptanceGate /> : null}
      <Modal visible={relocked} animationType="none" onRequestClose={() => undefined}>
        <UnlockScreen onUnlocked={unlockResumed} />
      </Modal>
    </>
  );
}
