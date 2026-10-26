// Push TOKEN REGISTRATION only (directive §8; M-A3 devices contract). The device token
// is attached server-side to the caller's own device session (`dsid` in the access
// token) — the app never names a device id (M-A1 §3.6).
//   PUT    /v1/sign/me/devices/current  {platform, provider, push_token, app_version}
//   DELETE /v1/sign/me/devices/current  (at sign-out, while still authenticated)
// Denied permission is fine: the in-app feed keeps working (acceptance §12.10).
// Push payload handling / tap routing is built by the notifications workstream.
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { WorkspaceClient } from '../api/workspaceClient';

export type PushRegistration = 'registered' | 'denied' | 'unsupported' | 'unavailable';

export const DEVICE_PATH = '/v1/sign/me/devices/current' as const;

export async function registerForPush(
  workspace: WorkspaceClient,
  opts: { readonly prompt: boolean },
): Promise<PushRegistration> {
  if (!Device.isDevice) return 'unsupported';
  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted && perm.canAskAgain && opts.prompt)
    perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return 'denied';
  let pushToken: string;
  try {
    // The NATIVE APNs / FCM token (Aramo delivers directly; no third-party push relay).
    pushToken = String((await Notifications.getDevicePushTokenAsync()).data);
  } catch {
    // e.g. Android without Firebase configuration (directive P-4) or no APNs entitlement.
    return 'unavailable';
  }
  await workspace.call(DEVICE_PATH, 'put', {
    body: {
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      provider: Platform.OS === 'ios' ? 'apns' : 'fcm',
      push_token: pushToken,
      app_version: Application.nativeApplicationVersion ?? '0.0.0',
    },
  });
  return 'registered';
}

export async function unregisterPush(workspace: WorkspaceClient): Promise<void> {
  await workspace.call(DEVICE_PATH, 'delete', {});
}
