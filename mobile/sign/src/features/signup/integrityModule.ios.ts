// iOS: Apple App Attest through @expo/app-integrity (Apple Go-Live R-9 / W5). One
// attestation per signup, no stored keys and no assertions:
//   1. generateKeyAsync() → a new Secure Enclave key; its id (base64) is the key_id;
//   2. attestKeyAsync(keyId, challenge) → Apple's attestation object (base64 CBOR).
// The native module computes clientDataHash = SHA-256(UTF-8(challenge)). The challenge is
// the canonical start JSON, so clientDataHash is exactly the requestHash digest bytes the
// server rebuilds from the received body (the same binding Android uses).
// integrity_token = base64url(UTF-8(JSON {key_id, attestation})).
import * as AppIntegrity from '@expo/app-integrity';

import { base64UrlEncode, utf8Encode } from '../../util/bytes';
import type { IntegrityModule } from './integrity';

/** The @expo/app-integrity iOS surface the app uses. */
export interface AppAttestNative {
  readonly isSupported: boolean;
  generateKeyAsync(): Promise<string>;
  attestKeyAsync(keyId: string, challenge: string): Promise<string>;
}

export function appAttestToken(keyId: string, attestation: string): string {
  return base64UrlEncode(utf8Encode(JSON.stringify({ key_id: keyId, attestation })));
}

export function createAppAttestModule(native: AppAttestNative): IntegrityModule | null {
  if (!native.isSupported) return null;
  return {
    client: 'ios',
    needsCloudProject: false,
    prepare: async () => undefined,
    async request(_requestHash, canonicalJson) {
      // A fresh key per signup: the server accepts a key_id once (replay guard).
      const keyId = await native.generateKeyAsync();
      const attestation = await native.attestKeyAsync(keyId, canonicalJson);
      if (!keyId || !attestation) throw new Error('app_attest_empty');
      return appAttestToken(keyId, attestation);
    },
  };
}

function nativeOrNull(): AppAttestNative | null {
  try {
    return AppIntegrity.isSupported ? AppIntegrity : null;
  } catch {
    // No native module in this build (or the simulator): signup shows "unavailable".
    return null;
  }
}

const native = nativeOrNull();

export const integrityModule: IntegrityModule | null =
  native === null ? null : createAppAttestModule(native);
