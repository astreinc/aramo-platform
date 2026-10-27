// Push lifecycle while signed in (directive §8; acceptance §12.10):
//   - registers the native APNs / FCM token through the foundation's registerForPush()
//     once per signed-in session; a denied permission is fine (the feed keeps working);
//   - shows foreground pushes as banners (the server already chose generic or subject
//     text per the lock-screen preference) and refreshes the badge;
//   - routes a tapped push to the right authenticated screen (pushRouting.ts), including
//     the push that cold-started the app.
// The app never reads or stores anything from a push beyond `{type, envelope_id |
// inbox_item_id}`.
import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';

import { useServices, useSession } from '../../app/ServicesContext';
import { navigationRef } from '../../navigation/navigationRef';
import { isHostedLocked } from '../hosted/hostedLock';
import { registerForPush, type PushRegistration } from '../../notifications/pushRegistration';
import type { NotificationTarget } from './notificationModel';
import { routeForPushData } from './pushRouting';
import { notificationKeys } from './queries';

export function openTarget(target: NotificationTarget): void {
  // Hosted (in-person) mode is locked (M-A5 §3.3): a tapped push opens nothing over it.
  if (isHostedLocked()) return;
  const go = () => {
    if (target.name === 'EnvelopeDetail') navigationRef.navigate('EnvelopeDetail', target.params);
    else navigationRef.navigate('ReceivedEnvelope', target.params);
  };
  if (navigationRef.isReady()) go();
  else setTimeout(() => openTarget(target), 50);
}

let lastRegistration: PushRegistration | null = null;

/** The outcome of the latest registration attempt (Account shows it). */
export function lastPushRegistration(): PushRegistration | null {
  return lastRegistration;
}

export function usePushLifecycle(): void {
  const { workspace } = useServices();
  const { status, deviceSessionId } = useSession();
  const qc = useQueryClient();
  const registeredFor = useRef<string | null>(null);

  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: async () => {
        void qc.invalidateQueries({ queryKey: notificationKeys.unread });
        void qc.invalidateQueries({ queryKey: notificationKeys.feed });
        return {
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: false,
          shouldSetBadge: true,
        };
      },
    });
  }, [qc]);

  useEffect(() => {
    if (status !== 'signedIn') return;
    const key = deviceSessionId ?? 'session';
    if (registeredFor.current === key) return;
    registeredFor.current = key;
    registerForPush(workspace, { prompt: true }).then(
      (r) => {
        lastRegistration = r;
      },
      () => {
        lastRegistration = 'unavailable';
      },
    );
  }, [status, deviceSessionId, workspace]);

  useEffect(() => {
    if (status !== 'signedIn') return undefined;
    const handle = (response: Notifications.NotificationResponse | null) => {
      const target = routeForPushData(response?.notification.request.content.data);
      if (target) {
        void qc.invalidateQueries({ queryKey: notificationKeys.unread });
        openTarget(target);
      }
    };
    void Notifications.getLastNotificationResponseAsync().then(
      (r) => {
        handle(r);
        void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
      },
      () => undefined,
    );
    const sub = Notifications.addNotificationResponseReceivedListener(handle);
    return () => sub.remove();
  }, [status, qc]);
}
