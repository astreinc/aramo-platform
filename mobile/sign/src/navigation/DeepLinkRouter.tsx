// Connects OS deep links to the app (M-A2 §3): initial URL + 'url' events, routed by the
// pure routeLink(). Tokens go to the in-memory vault; nothing is logged or stored.
import { useEffect, useRef } from 'react';
import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { useSession } from '../app/ServicesContext';
import { deliverCallback } from '../auth/callbackBus';
import { stashGuestToken } from '../links/guestTokenVault';
import { setPendingTarget, takePendingTarget } from '../links/pendingTarget';
import { requiresSession, routeLink, type LinkRoute } from '../links/routeLink';
import { navigationRef } from './navigationRef';

function whenReady(fn: () => void): void {
  if (navigationRef.isReady()) fn();
  else setTimeout(() => whenReady(fn), 50);
}

function openAuthenticated(route: Extract<LinkRoute, { kind: 'envelope' | 'inbox-sign' }>): void {
  whenReady(() => {
    if (route.kind === 'envelope')
      navigationRef.navigate('EnvelopeDetail', { envelopeId: route.envelopeId });
    else navigationRef.navigate('Signing', { envelopeId: route.envelopeId });
  });
}

export function DeepLinkRouter() {
  const { status } = useSession();
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    function handle(url: string | null): void {
      if (!url) return;
      const route = routeLink(url);
      switch (route.kind) {
        case 'guest': {
          const handle = stashGuestToken(route.token);
          whenReady(() => navigationRef.navigate('GuestSigning', { handle, mode: route.mode }));
          return;
        }
        case 'auth-callback':
          deliverCallback(route.url); // dropped when no sign-in is waiting
          return;
        case 'envelope':
        case 'inbox-sign':
          if (requiresSession(route) && statusRef.current !== 'signedIn') setPendingTarget(route);
          else openAuthenticated(route);
          return;
        case 'browser':
          void WebBrowser.openBrowserAsync(route.url).catch(() => undefined);
          return;
        case 'ignore':
          return;
      }
    }
    void Linking.getInitialURL().then(handle, () => undefined);
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  // After sign-in, continue to the kept deep-link target.
  useEffect(() => {
    if (status !== 'signedIn') return;
    const target = takePendingTarget();
    if (target) openAuthenticated(target);
  }, [status]);

  return null;
}
