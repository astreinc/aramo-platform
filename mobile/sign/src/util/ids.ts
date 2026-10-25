import * as Crypto from 'expo-crypto';

/** RFC 4122 v4 id from the platform CSPRNG. */
export function randomId(): string {
  return Crypto.randomUUID();
}
