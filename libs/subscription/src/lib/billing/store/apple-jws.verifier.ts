import { X509Certificate } from 'node:crypto';

import { compactVerify, decodeProtectedHeader } from 'jose';

import { APPLE_ROOT_CA_G3_PEM } from './apple-root-ca.js';

// Aramo Sign Mobile M-A12 W1-G item 3 (LOCKED) — verification of an App Store signed payload
// (StoreKit 2 signed transaction, signed renewal info, App Store Server Notification v2
// `signedPayload`, App Store Server API responses). The payload is trusted ONLY when:
//   1. the JWS header is ES256 and carries an x5c chain of exactly 3 certificates;
//   2. x5c[2] is byte-equal to a trusted root (production: the embedded Apple Root CA - G3);
//   3. the intermediate is issued and signed by the root, and the leaf by the intermediate;
//   4. the leaf carries Apple's receipt-signing marker OID (1.2.840.113635.100.6.11.1) and the
//      intermediate Apple's WWDR intermediate marker OID (1.2.840.113635.100.6.2.1);
//   5. every certificate is within its validity at the effective date (the payload's signedDate when
//      it carries one, as Apple's own verifier does without online revocation checks; else now);
//   6. the JWS signature verifies with the leaf public key.
// Any failure throws AppleJwsError with a reason code. The JWS and its payload are never logged.

export type AppleJwsFailure = 'malformed' | 'bad_algorithm' | 'bad_chain' | 'untrusted_root' | 'certificate_expired' | 'bad_marker' | 'bad_signature';

export class AppleJwsError extends Error {
  constructor(public readonly reason: AppleJwsFailure) {
    super(`app store signed payload rejected: ${reason}`);
    this.name = 'AppleJwsError';
  }
}

/** DER encodings (tag 06, length 0A) of Apple's marker OIDs. */
const LEAF_MARKER = Buffer.from('060a2a864886f76364060b01', 'hex'); // 1.2.840.113635.100.6.11.1
const INTERMEDIATE_MARKER = Buffer.from('060a2a864886f76364060201', 'hex'); // 1.2.840.113635.100.6.2.1

export interface AppleJwsVerifierOptions {
  /** Trusted roots (PEM or DER). Production: the embedded Apple Root CA - G3 only. */
  roots?: readonly (string | Buffer)[];
  /** Clock (tests). */
  now?: () => Date;
}

function cert(der: string): X509Certificate {
  try {
    return new X509Certificate(Buffer.from(der, 'base64'));
  } catch {
    throw new AppleJwsError('malformed');
  }
}

function within(c: X509Certificate, at: Date): boolean {
  const from = Date.parse(c.validFrom);
  const to = Date.parse(c.validTo);
  return Number.isFinite(from) && Number.isFinite(to) && at.getTime() >= from && at.getTime() <= to;
}

export class AppleJwsVerifier {
  private readonly roots: X509Certificate[];
  private readonly now: () => Date;

  constructor(opts: AppleJwsVerifierOptions = {}) {
    this.roots = (opts.roots ?? [APPLE_ROOT_CA_G3_PEM]).map((r) => new X509Certificate(r));
    this.now = opts.now ?? (() => new Date());
  }

  /** Verify and decode one signed payload (fails closed). */
  async verify<T = Record<string, unknown>>(jws: string): Promise<T> {
    if (typeof jws !== 'string' || jws.length === 0 || jws.length > 65_536 || jws.split('.').length !== 3) throw new AppleJwsError('malformed');
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(jws);
    } catch {
      throw new AppleJwsError('malformed');
    }
    if (header.alg !== 'ES256') throw new AppleJwsError('bad_algorithm');
    const x5c = header.x5c;
    if (!Array.isArray(x5c) || x5c.length !== 3 || !x5c.every((c) => typeof c === 'string')) throw new AppleJwsError('bad_chain');
    const [leaf, intermediate, root] = x5c.map(cert) as [X509Certificate, X509Certificate, X509Certificate];
    if (!this.roots.some((r) => r.raw.equals(root.raw))) throw new AppleJwsError('untrusted_root');
    if (!intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) throw new AppleJwsError('bad_chain');
    if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) throw new AppleJwsError('bad_chain');
    if (!leaf.raw.includes(LEAF_MARKER) || !intermediate.raw.includes(INTERMEDIATE_MARKER)) throw new AppleJwsError('bad_marker');
    let payload: Record<string, unknown>;
    try {
      const out = await compactVerify(jws, leaf.publicKey, { algorithms: ['ES256'] });
      payload = JSON.parse(new TextDecoder().decode(out.payload)) as Record<string, unknown>;
    } catch {
      throw new AppleJwsError('bad_signature');
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new AppleJwsError('malformed');
    const signed = typeof payload['signedDate'] === 'number' ? new Date(payload['signedDate']) : null;
    const at = signed !== null && Number.isFinite(signed.getTime()) ? signed : this.now();
    if (![leaf, intermediate, root].every((c) => within(c, at))) throw new AppleJwsError('certificate_expired');
    return payload as T;
  }
}

// ---- the decoded shapes Aramo reads (App Store Server API / Notifications v2) ----------------

export interface AppleTransactionPayload {
  transactionId?: string;
  originalTransactionId?: string;
  bundleId?: string;
  productId?: string;
  purchaseDate?: number;
  expiresDate?: number;
  appAccountToken?: string;
  environment?: string;
  revocationDate?: number;
  type?: string;
  signedDate?: number;
}

export interface AppleRenewalInfoPayload {
  originalTransactionId?: string;
  autoRenewStatus?: number;
  autoRenewProductId?: string;
  productId?: string;
  isInBillingRetryPeriod?: boolean;
  gracePeriodExpiresDate?: number;
  environment?: string;
  signedDate?: number;
}

export interface AppleNotificationPayload {
  notificationType?: string;
  subtype?: string;
  notificationUUID?: string;
  signedDate?: number;
  data?: {
    bundleId?: string;
    environment?: string;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
    status?: number;
  };
}
