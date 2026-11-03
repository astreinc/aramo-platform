// Play Integrity binding for native Personal signup (M-A11 §2.1, Lead correction 1).
// Standard requests bind the request with `requestHash`: the lowercase hex SHA-256 of the
// UTF-8 bytes of JSON.stringify([client, name, email, phone, residence, invite_code ?? null,
// hp, elapsed_ms]), built from the values EXACTLY as sent (after the app's own trimming,
// before any server normalization) and never including the token. The server rebuilds the
// same array from the received body, so the app hashes the body object it then sends.
import { platformCrypto, type CryptoPort } from '../../auth/pkce';
import { utf8Encode } from '../../util/bytes';
import type { NativeStartBody } from './signupApi';

/** The native module surface the app uses (Android: @expo/app-integrity). */
export interface IntegrityModule {
  prepare(cloudProjectNumber: string): Promise<void>;
  request(requestHash: string): Promise<string>;
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

export async function startRequestHash(
  body: NativeStartBody,
  crypto: Pick<CryptoPort, 'sha256'> = platformCrypto,
): Promise<string> {
  return toHex(await crypto.sha256(utf8Encode(JSON.stringify(canonicalStartArray(body)))));
}

/**
 * One signup screen session: the token provider is warmed up once (on the details screen),
 * then each start asks for a token bound to that request's hash. A failed warm-up is
 * retried once at submit.
 */
export interface IntegritySession {
  warmUp(): void;
  tokenFor(body: NativeStartBody): Promise<string>;
}

export function createIntegritySession(
  module: IntegrityModule,
  cloudProjectNumber: string,
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
    warmUp() {
      prepare().catch(() => undefined);
    },
    async tokenFor(body) {
      await prepare();
      const token = await module.request(await startRequestHash(body, crypto));
      if (typeof token !== 'string' || token === '') throw new Error('integrity_token_empty');
      return token;
    },
  };
}
