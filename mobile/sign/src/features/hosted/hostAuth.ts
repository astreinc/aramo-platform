// The host's device authentication to leave hosted mode (M-A5 §3.3, §8 Q6): biometrics
// or the device passcode (expo-local-authentication with the device fallback). Local
// only, like every biometric check in this app (M-A1 §4): never sent to the server.
//
// When the device has no passcode and no biometrics enrolled, device authentication is
// impossible. The workspace must still not reappear for whoever holds the device, so the
// exit signs the workspace session out instead: the host signs in again (the existing
// sign-in, M-A1) to see the workspace. This is the chosen fallback ("unavailable").
import * as LocalAuthentication from 'expo-local-authentication';

export type HostAuthResult = 'ok' | 'failed' | 'unavailable';

export interface HostAuthDeps {
  /** SecurityLevel: 0 = nothing enrolled (no passcode, no biometrics). */
  readonly enrolledLevel: () => Promise<number>;
  /** The system prompt; `unavailable` when the OS reports nothing to authenticate with. */
  readonly authenticate: (prompt: string) => Promise<'ok' | 'failed' | 'unavailable'>;
}

/** Errors meaning the device cannot authenticate at all (not a failed attempt). */
const UNAVAILABLE_ERRORS = new Set(['not_enrolled', 'passcode_not_set', 'not_available']);

export const deviceHostAuth: HostAuthDeps = {
  enrolledLevel: async () => Number(await LocalAuthentication.getEnrolledLevelAsync()),
  authenticate: async (promptMessage) => {
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    if (r.success) return 'ok';
    return UNAVAILABLE_ERRORS.has(r.error) ? 'unavailable' : 'failed';
  },
};

export async function authenticateHost(
  deps: HostAuthDeps,
  prompt: string,
): Promise<HostAuthResult> {
  const level = await deps.enrolledLevel().catch(() => 0);
  if (!(level > 0)) return 'unavailable';
  return deps.authenticate(prompt).catch(() => 'failed' as const);
}
