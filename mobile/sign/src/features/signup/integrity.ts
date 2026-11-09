// Play Integrity (Android) and App Attest (iOS, Apple Go-Live R-9) binding for native
// Personal signup (M-A11 §2.1, Lead correction 1).
// Standard requests bind the request with `requestHash`: the lowercase hex SHA-256 of the
// UTF-8 bytes of JSON.stringify([client, name, email, phone, residence, invite_code ?? null,
// hp, elapsed_ms]), built from the values EXACTLY as sent (after the app's own trimming,
// before any server normalization) and never including the token. The server rebuilds the
// same array from the received body, so the app hashes the body object it then sends.
import { platformCrypto, type CryptoPort } from '../../auth/pkce';
import { utf8Encode } from '../../util/bytes';
import type { NativeStartBody } from './signupApi';

/**
 * The native module surface the app uses (@expo/app-integrity): Play Integrity on Android
 * (M-A11), App Attest on iOS (Apple Go-Live R-9). `request` gets the requestHash (lowercase
 * hex) AND the canonical JSON it is the SHA-256 of: Play binds the hex string, while the
 * iOS module hashes the string it is given into App Attest's clientDataHash, so passing the
 * canonical JSON makes clientDataHash exactly the requestHash digest bytes.
 */
export interface IntegrityModule {
  /** The `client` value sent with this module's tokens. */
  readonly client: 'android' | 'ios';
  /** Android needs the Play cloud project number; iOS needs nothing. */
  readonly needsCloudProject: boolean;
  prepare(cloudProjectNumber: string | null): Promise<void>;
  request(requestHash: string, canonicalJson: string): Promise<string>;
}

/** The canonical array, in the contract's order. */
export function canonicalStartArray(body: NativeStartBody): readonly unknown[] {
  return [
    body.client,
    body.name,
    body.email,
    body.phone,
    body.residence,
    body.invite_code ?? null,
    body.hp,
    body.elapsed_ms,
  ];
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** The exact string whose UTF-8 bytes are hashed into the requestHash. */
export function canonicalStartJson(body: NativeStartBody): string {
  return JSON.stringify(canonicalStartArray(body));
}

export async function startRequestHash(
  body: NativeStartBody,
  crypto: Pick<CryptoPort, 'sha256'> = platformCrypto,
): Promise<string> {
  return toHex(await crypto.sha256(utf8Encode(canonicalStartJson(body))));
}

/**
 * One signup screen session: the token provider is warmed up once (on the details screen),
 * then each start asks for a token bound to that request's hash. A failed warm-up is
 * retried once at submit.
 */
export interface IntegritySession {
  /** The `client` the start body (and the requestHash) must carry. */
  readonly client: 'android' | 'ios';
  warmUp(): void;
  tokenFor(body: NativeStartBody): Promise<string>;
}

/** A session for `module`, or null when this build can't run it (no Play cloud project). */
export function integritySessionFor(
  module: IntegrityModule | null,
  cloudProjectNumber: string | null,
  crypto: Pick<CryptoPort, 'sha256'> = platformCrypto,
): IntegritySession | null {
  if (module === null || (module.needsCloudProject && cloudProjectNumber === null)) return null;
  return createIntegritySession(module, cloudProjectNumber, crypto);
}

export function createIntegritySession(
  module: IntegrityModule,
  cloudProjectNumber: string | null,
  crypto: Pick<CryptoPort, 'sha256'> = platformCrypto,
): IntegritySession {
  let prepared: Promise<void> | null = null;
  const prepare = (): Promise<void> => {
    prepared ??= module.prepare(cloudProjectNumber).catch((e: unknown) => {
      prepared = null;
      throw e;
    });
    return prepared;
  };
  return {
    client: module.client,
    warmUp() {
      prepare().catch(() => undefined);
    },
    async tokenFor(body) {
      if (body.client !== module.client) throw new Error('integrity_client_mismatch');
      await prepare();
      const token = await module.request(
        await startRequestHash(body, crypto),
        canonicalStartJson(body),
      );
      if (typeof token !== 'string' || token === '') throw new Error('integrity_token_empty');
      return token;
    },
  };
}
