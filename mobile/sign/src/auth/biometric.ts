// Local biometric confirmation (directive §3.7; M-A1 §4). It proves only that the device
// is in the user's hand: it is never sent to the server, never creates or extends a
// session, and never appears on a certificate or evidence record.
import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

import { SECURE_KEYS, type SecureKeyValue } from './secureKeyValue';

export type BiometricKind = 'face' | 'fingerprint' | 'iris' | 'none';

export interface BiometricCapability {
  readonly available: boolean;
  readonly kind: BiometricKind;
  /** "Face ID" / "fingerprint" for the Account toggle label (handoff §4.9). */
  readonly label: string;
}

export async function biometricCapability(): Promise<BiometricCapability> {
  const [hardware, enrolled, types] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
    LocalAuthentication.supportedAuthenticationTypesAsync(),
  ]);
  const T = LocalAuthentication.AuthenticationType;
  const kind: BiometricKind = types.includes(T.FACIAL_RECOGNITION)
    ? 'face'
    : types.includes(T.FINGERPRINT)
      ? 'fingerprint'
      : types.includes(T.IRIS)
        ? 'iris'
        : 'none';
  const available = hardware && enrolled && kind !== 'none';
  const label =
    kind === 'face' ? (Platform.OS === 'ios' ? 'Face ID' : 'face unlock') : 'fingerprint';
  return { available, kind, label };
}

/** Shows the system prompt. Resolves false on failure or cancel (stay on the page). */
export async function confirmLocally(promptMessage: string): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel: 'Cancel',
    disableDeviceFallback: false,
  });
  return result.success;
}

async function readFlag(kv: SecureKeyValue, key: string, fallback: boolean): Promise<boolean> {
  const v = await kv.getItem(key);
  return v === null ? fallback : v === '1';
}

/** "Confirm signing with Face ID / fingerprint" — default ON (handoff §4.9). */
export const biometricConfirmPref = {
  get: (kv: SecureKeyValue) => readFlag(kv, SECURE_KEYS.biometricConfirm, true),
  set: (kv: SecureKeyValue, on: boolean) =>
    kv.setItem(SECURE_KEYS.biometricConfirm, on ? '1' : '0'),
};

/** Optional app unlock gating the locally stored session — default OFF. Asked at launch
 * and again when the app returns after at least RELOCK_AFTER_MS in the background. */
export const biometricUnlockPref = {
  get: (kv: SecureKeyValue) => readFlag(kv, SECURE_KEYS.biometricUnlock, false),
  set: (kv: SecureKeyValue, on: boolean) => kv.setItem(SECURE_KEYS.biometricUnlock, on ? '1' : '0'),
};

/** Background time after which the app asks to unlock again (when unlock is on). */
export const RELOCK_AFTER_MS = 5 * 60_000;

export function shouldRelock(backgroundedAt: number | null, now: number): boolean {
  return backgroundedAt !== null && now - backgroundedAt >= RELOCK_AFTER_MS;
}
