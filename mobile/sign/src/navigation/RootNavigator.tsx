// Auth-gated root stack (handoff §2). Signed out: Sign in + guest signing. Signed in:
// tabs (Home · Agreements) + the side-menu screens (Notifications, Account, Templates) +
// detail/signing/viewer/send. Guest signing is reachable in both states.
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { useServices, useSession } from '../app/ServicesContext';
import { biometricCapability, biometricUnlockPref } from '../auth/biometric';
import { setPendingTarget } from '../links/pendingTarget';
import { AccountScreen } from '../screens/account/AccountScreen';
import { DocumentViewerScreen } from '../screens/documents/DocumentViewerScreen';
import { EnvelopeDetailScreen } from '../screens/envelope/EnvelopeDetailScreen';
import { HostedSigningScreen } from '../screens/hosted/HostedSigningScreen';
import { ReceivedEnvelopeScreen } from '../screens/envelope/ReceivedEnvelopeScreen';
import { NotificationsScreen } from '../screens/notifications/NotificationsScreen';
import { SendFlowScreen } from '../screens/send/SendFlowScreen';
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

export function RootNavigator() {
  const t = useTheme();
  const snap = useSession();
  useKeepTargetOnExpiry();
  const [lock, unlock] = useBiometricLock(
    snap.status === 'signedIn' ? (snap.deviceSessionId ?? 'session') : null,
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
    <Stack.Navigator
      screenOptions={{
        headerTintColor: t.color.accent,
        contentStyle: { backgroundColor: t.color.screen },
      }}
    >
      {snap.status === 'signedOut' ? (
        <Stack.Screen name="SignIn" component={SignInScreen} options={{ headerShown: false }} />
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
          <Stack.Screen name="Account" component={AccountScreen} options={{ headerShown: false }} />
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
  );
}
