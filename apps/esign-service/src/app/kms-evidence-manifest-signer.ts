import { createHash } from 'node:crypto';

import { KMSClient, SignCommand, VerifyCommand, type SigningAlgorithmSpec } from '@aws-sdk/client-kms';
import {
  type EvidenceManifest,
  type EvidenceManifestSignerPort,
  type SignedEvidenceManifest,
} from '@aramo/esign';

// DOC-4 (R-4-5) — the AWS-KMS-backed EvidenceManifestSignerPort. The private key
// NEVER leaves KMS (§262) — signing is a KMS SignCommand over the manifest
// digest; verification is a KMS VerifyCommand. Implements the identical port the
// DOC-3 software signer does — no domain change. Bound by the composition root
// ONLY when a KMS key is configured; the software signer remains the default.

export interface KmsEvidenceSignerConfig {
  keyId: string;
  signingAlgorithm: SigningAlgorithmSpec; // e.g. RSASSA_PKCS1_V1_5_SHA_256 | ECDSA_SHA_256
}

export class KmsEvidenceManifestSigner implements EvidenceManifestSignerPort {
  constructor(
    private readonly client: KMSClient,
    private readonly config: KmsEvidenceSignerConfig,
  ) {}

  // sha256 digest of the canonical manifest — the message KMS signs (DIGEST mode).
  private digest(manifest: EvidenceManifest): Uint8Array {
    return new Uint8Array(createHash('sha256').update(JSON.stringify(manifest)).digest());
  }

  async sign(manifest: EvidenceManifest, signingTimestamp: string): Promise<SignedEvidenceManifest> {
    const res = await this.client.send(
      new SignCommand({
        KeyId: this.config.keyId,
        Message: this.digest(manifest),
        MessageType: 'DIGEST',
        SigningAlgorithm: this.config.signingAlgorithm,
      }),
    );
    if (res.Signature === undefined) {
      throw new Error('KMS SignCommand returned no signature');
    }
    return {
      manifest,
      signature: Buffer.from(res.Signature).toString('base64url'),
      signature_algorithm: `KMS:${this.config.signingAlgorithm}`,
      kms_key_version_ref: res.KeyId ?? this.config.keyId,
      signing_timestamp: signingTimestamp,
    };
  }

  async verify(signed: SignedEvidenceManifest): Promise<boolean> {
    const res = await this.client.send(
      new VerifyCommand({
        KeyId: this.config.keyId,
        Message: this.digest(signed.manifest),
        MessageType: 'DIGEST',
        Signature: new Uint8Array(Buffer.from(signed.signature, 'base64url')),
        SigningAlgorithm: this.config.signingAlgorithm,
      }),
    );
    return res.SignatureValid === true;
  }
}

// Env-gated factory — the composition root binds KMS ONLY when ESIGN_KMS_KEY_ID
// is set; otherwise the caller falls back to the software signer. Real key +
// grants are provisioned in IaC from the Mac (DEPLOY=NO).
export function kmsEvidenceSignerFromEnv(env: NodeJS.ProcessEnv): KmsEvidenceManifestSigner | null {
  const keyId = env['ESIGN_KMS_KEY_ID'];
  if (keyId === undefined || keyId === '') return null;
  const signingAlgorithm = (env['ESIGN_KMS_SIGNING_ALGORITHM'] ?? 'RSASSA_PKCS1_V1_5_SHA_256') as SigningAlgorithmSpec;
  const region = env['AWS_REGION'] ?? env['AWS_DEFAULT_REGION'];
  const client = new KMSClient(region !== undefined ? { region } : {});
  return new KmsEvidenceManifestSigner(client, { keyId, signingAlgorithm });
}
