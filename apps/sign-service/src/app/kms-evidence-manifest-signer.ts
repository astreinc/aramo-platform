import { createHash } from 'node:crypto';

import {
  DescribeKeyCommand,
  GetPublicKeyCommand,
  KMSClient,
  KMSInvalidSignatureException,
  SignCommand,
  VerifyCommand,
} from '@aws-sdk/client-kms';
import {
  KMS_SIGNATURE_ALGORITHM_PREFIX,
  SoftwareEvidenceManifestSigner,
  canonicalEvidenceManifestBytes,
  isKmsEvidenceSigningAlgorithm,
  kmsEvidenceAlgorithmHash,
  verifyKmsEvidenceSignatureWithPublicKey,
  type EvidenceManifest,
  type EvidenceManifestSignerPort,
  type KmsEvidenceSigningAlgorithm,
  type SignedEvidenceManifest,
} from '@aramo/sign';

import { loadSignAwsCredentials, signAwsRegion } from './custody/sign-artifact-storage.config.js';

// DOC-4 (R-4-5) + SX-1 item 4 / LC-3 — the AWS-KMS-backed EvidenceManifestSignerPort.
// The private key NEVER leaves KMS (§262): signing is a KMS Sign over the manifest
// digest with an ASYMMETRIC SIGN_VERIFY key. A plain SHA-256 digest is an
// integrity digest, not a signature, so the configured key is checked
// (DescribeKey) before the first signature and the signer fails closed unless it
// is an enabled asymmetric SIGN_VERIFY key whose supported algorithms include the
// one in use. The signed manifest records the key ARN (the version ref — KMS
// asymmetric keys are not rotated in place) and `KMS:<algorithm>`.

export const SIGN_KMS_KEY_ID_ENV = 'SIGN_KMS_KEY_ID';
export const SIGN_KMS_SIGNING_ALGORITHM_ENV = 'SIGN_KMS_SIGNING_ALGORITHM';

export interface KmsEvidenceSignerConfig {
  keyId: string;
  // Optional: when omitted the algorithm is chosen from the key spec
  // (ECC_NIST_P256 → ECDSA_SHA_256, RSA_* → RSASSA_PSS_SHA_256, …).
  signingAlgorithm?: KmsEvidenceSigningAlgorithm;
}

export interface ResolvedKmsSigningKey {
  keyArn: string;
  keySpec: string;
  signingAlgorithm: KmsEvidenceSigningAlgorithm;
}

export class KmsEvidenceKeyRefusedError extends Error {
  constructor(message: string) {
    super(`KMS evidence signing key refused: ${message}`);
    this.name = 'KmsEvidenceKeyRefusedError';
  }
}

const DEFAULT_ALGORITHM_BY_KEY_SPEC: Record<string, KmsEvidenceSigningAlgorithm> = {
  ECC_NIST_P256: 'ECDSA_SHA_256',
  ECC_NIST_P384: 'ECDSA_SHA_384',
  ECC_NIST_P521: 'ECDSA_SHA_512',
  RSA_2048: 'RSASSA_PSS_SHA_256',
  RSA_3072: 'RSASSA_PSS_SHA_256',
  RSA_4096: 'RSASSA_PSS_SHA_256',
};

export class KmsEvidenceManifestSigner implements EvidenceManifestSignerPort {
  private resolved: Promise<ResolvedKmsSigningKey> | undefined;

  constructor(
    private readonly client: KMSClient,
    private readonly config: KmsEvidenceSignerConfig,
  ) {}

  /**
   * DescribeKey the configured key ONCE and refuse anything but an enabled
   * asymmetric SIGN_VERIFY key with a supported algorithm. Called at boot by the
   * composition root and again (memoized) before the first signature.
   */
  assertSigningKey(): Promise<ResolvedKmsSigningKey> {
    if (this.resolved === undefined) {
      this.resolved = this.describe();
      // A refused/failed check is not cached: the next call re-checks.
      this.resolved.catch(() => {
        this.resolved = undefined;
      });
    }
    return this.resolved;
  }

  private async describe(): Promise<ResolvedKmsSigningKey> {
    const res = await this.client.send(new DescribeKeyCommand({ KeyId: this.config.keyId }));
    const meta = res.KeyMetadata;
    if (meta === undefined) throw new KmsEvidenceKeyRefusedError('DescribeKey returned no key metadata');
    if (meta.KeyUsage !== 'SIGN_VERIFY') {
      throw new KmsEvidenceKeyRefusedError(`key usage is ${String(meta.KeyUsage)}, expected SIGN_VERIFY`);
    }
    const keySpec = String(meta.KeySpec ?? '');
    if (keySpec === '' || keySpec === 'SYMMETRIC_DEFAULT' || keySpec.startsWith('HMAC_')) {
      throw new KmsEvidenceKeyRefusedError(`key spec ${keySpec || '(none)'} is not asymmetric`);
    }
    if (meta.KeyState !== 'Enabled') {
      throw new KmsEvidenceKeyRefusedError(`key state is ${String(meta.KeyState)}, expected Enabled`);
    }
    const signingAlgorithm = this.config.signingAlgorithm ?? DEFAULT_ALGORITHM_BY_KEY_SPEC[keySpec];
    if (signingAlgorithm === undefined) {
      throw new KmsEvidenceKeyRefusedError(`no supported signing algorithm for key spec ${keySpec}`);
    }
    const supported = (meta.SigningAlgorithms ?? []).map(String);
    if (!supported.includes(signingAlgorithm)) {
      throw new KmsEvidenceKeyRefusedError(`key does not support ${signingAlgorithm} (supports: ${supported.join(', ') || 'none'})`);
    }
    if (meta.Arn === undefined || meta.Arn === '') throw new KmsEvidenceKeyRefusedError('DescribeKey returned no key ARN');
    return { keyArn: meta.Arn, keySpec, signingAlgorithm };
  }

  // Digest of the canonical manifest with the algorithm's own hash — the message
  // KMS signs in DIGEST mode.
  private digest(manifest: EvidenceManifest, algorithm: KmsEvidenceSigningAlgorithm): Uint8Array {
    return new Uint8Array(
      createHash(kmsEvidenceAlgorithmHash(algorithm)).update(canonicalEvidenceManifestBytes(manifest)).digest(),
    );
  }

  async sign(manifest: EvidenceManifest, signingTimestamp: string): Promise<SignedEvidenceManifest> {
    const key = await this.assertSigningKey();
    const res = await this.client.send(
      new SignCommand({
        KeyId: key.keyArn,
        Message: this.digest(manifest, key.signingAlgorithm),
        MessageType: 'DIGEST',
        SigningAlgorithm: key.signingAlgorithm,
      }),
    );
    if (res.Signature === undefined || res.Signature.length === 0) {
      throw new Error('KMS Sign returned no signature');
    }
    return {
      manifest,
      signature: Buffer.from(res.Signature).toString('base64url'),
      signature_algorithm: `${KMS_SIGNATURE_ALGORITHM_PREFIX}${key.signingAlgorithm}`,
      kms_key_version_ref: res.KeyId ?? key.keyArn,
      signing_timestamp: signingTimestamp,
    };
  }

  /**
   * KMS Verify against the key recorded in the signed manifest (falling back to
   * the configured key) with the recorded algorithm. Fails closed: a non-KMS or
   * unsupported algorithm is false, and KMS's invalid-signature error is false.
   */
  async verify(signed: SignedEvidenceManifest): Promise<boolean> {
    const algorithm = recordedKmsAlgorithm(signed);
    if (algorithm === null) return false;
    try {
      const res = await this.client.send(
        new VerifyCommand({
          KeyId: signed.kms_key_version_ref ?? this.config.keyId,
          Message: this.digest(signed.manifest, algorithm),
          MessageType: 'DIGEST',
          Signature: new Uint8Array(Buffer.from(signed.signature, 'base64url')),
          SigningAlgorithm: algorithm,
        }),
      );
      return res.SignatureValid === true;
    } catch (err) {
      if (err instanceof KMSInvalidSignatureException) return false;
      throw err;
    }
  }
}

function recordedKmsAlgorithm(signed: SignedEvidenceManifest): KmsEvidenceSigningAlgorithm | null {
  if (!signed.signature_algorithm.startsWith(KMS_SIGNATURE_ALGORITHM_PREFIX)) return null;
  const algorithm = signed.signature_algorithm.slice(KMS_SIGNATURE_ALGORITHM_PREFIX.length);
  return isKmsEvidenceSigningAlgorithm(algorithm) ? algorithm : null;
}

/**
 * Offline verification for recovery validation: fetch the KMS PUBLIC key
 * (GetPublicKey) for the key recorded in the signed manifest and verify locally.
 * Needs only kms:GetPublicKey, never kms:Sign.
 */
export async function verifyEvidenceManifestWithKmsPublicKey(
  client: KMSClient,
  signed: SignedEvidenceManifest,
  fallbackKeyId?: string,
): Promise<boolean> {
  const keyId = signed.kms_key_version_ref ?? fallbackKeyId;
  if (keyId === undefined || keyId === '') return false;
  const res = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (res.PublicKey === undefined || res.KeyUsage !== 'SIGN_VERIFY') return false;
  return verifyKmsEvidenceSignatureWithPublicKey(signed, res.PublicKey);
}

/**
 * The KMS client for evidence signing, bound EXPLICITLY to the Sign-only identity
 * (SIGN_ARTIFACT_AWS_*, the same pair the artifact store uses). The evidence key's
 * policy admits only that principal, and in sign-service the SDK default chain is
 * the box-wide shared AWS_* key, so the default chain is never used here: without
 * the Sign pair this refuses, and sign-service does not start with the KMS signer.
 */
export function signKmsClientFromEnv(env: NodeJS.ProcessEnv): KMSClient {
  const credentials = loadSignAwsCredentials(env);
  if (credentials === null) {
    throw new KmsEvidenceKeyRefusedError(
      `${SIGN_KMS_KEY_ID_ENV} requires the Sign-only credential (SIGN_ARTIFACT_AWS_ACCESS_KEY_ID and SIGN_ARTIFACT_AWS_SECRET_ACCESS_KEY); the shared AWS_* credential is never used for evidence signing`,
    );
  }
  return new KMSClient({ region: signAwsRegion(env), credentials });
}

// Env-gated factory — builds the KMS signer ONLY when SIGN_KMS_KEY_ID is set.
// An unknown SIGN_KMS_SIGNING_ALGORITHM is refused (never silently replaced).
export function kmsEvidenceSignerFromEnv(env: NodeJS.ProcessEnv): KmsEvidenceManifestSigner | null {
  const keyId = (env[SIGN_KMS_KEY_ID_ENV] ?? '').trim();
  if (keyId === '') return null;
  const rawAlgorithm = (env[SIGN_KMS_SIGNING_ALGORITHM_ENV] ?? '').trim();
  let signingAlgorithm: KmsEvidenceSigningAlgorithm | undefined;
  if (rawAlgorithm !== '') {
    if (!isKmsEvidenceSigningAlgorithm(rawAlgorithm)) {
      throw new KmsEvidenceKeyRefusedError(`${SIGN_KMS_SIGNING_ALGORITHM_ENV}=${rawAlgorithm} is not a supported asymmetric signing algorithm`);
    }
    signingAlgorithm = rawAlgorithm;
  }
  const client = signKmsClientFromEnv(env);
  return new KmsEvidenceManifestSigner(client, signingAlgorithm === undefined ? { keyId } : { keyId, signingAlgorithm });
}

export function isProductionNodeEnv(env: NodeJS.ProcessEnv): boolean {
  return (env['NODE_ENV'] ?? '').trim().toLowerCase() === 'production';
}

/**
 * SX-1 item 4 — the composition-root binding. Production (NODE_ENV=production)
 * REFUSES to start without SIGN_KMS_KEY_ID and refuses a key that is not an
 * enabled asymmetric SIGN_VERIFY key (DescribeKey at boot). Non-production
 * without a key keeps the software digest signer.
 */
export async function resolveEvidenceManifestSigner(
  env: NodeJS.ProcessEnv,
  buildKmsSigner: (env: NodeJS.ProcessEnv) => KmsEvidenceManifestSigner | null = kmsEvidenceSignerFromEnv,
): Promise<EvidenceManifestSignerPort> {
  const kms = buildKmsSigner(env);
  if (kms !== null) {
    await kms.assertSigningKey();
    return kms;
  }
  if (isProductionNodeEnv(env)) {
    throw new Error(
      `sign-service refuses to start: NODE_ENV=production requires ${SIGN_KMS_KEY_ID_ENV} (an asymmetric KMS SIGN_VERIFY key) for evidence signing; the software digest signer is not allowed in production`,
    );
  }
  return new SoftwareEvidenceManifestSigner();
}
