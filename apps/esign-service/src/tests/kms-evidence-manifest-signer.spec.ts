import { SignCommand, VerifyCommand, type KMSClient } from '@aws-sdk/client-kms';
import { describe, expect, it, vi } from 'vitest';
import { type EvidenceManifest } from '@aramo/esign';

import { KmsEvidenceManifestSigner, kmsEvidenceSignerFromEnv } from '../app/kms-evidence-manifest-signer.js';

// DOC-4 (R-4-5) — the KMS evidence signer, unit-tested against a MOCKED KMS
// client (no live AWS). Proves the port contract: sign → base64url signature +
// KMS:<alg> algorithm + key-version ref; verify → KMS VerifyCommand result.

const MANIFEST: EvidenceManifest = {
  envelope_id: '11111111-1111-7111-8111-111111111111',
  source_sha256: 'a'.repeat(64),
  executed_sha256: 'b'.repeat(64),
  event_chain_hash: 'chain',
  disclosure_hash: 'disc',
  execution_manifest_hash: 'chain',
  consent_version: 'v1',
  signers: ['33333333-3333-7333-8333-333333333333'],
  completed_at: '2026-09-23T00:00:00.000Z',
  service_version: 'doc4',
};

describe('KmsEvidenceManifestSigner', () => {
  it('signs the manifest digest via KMS and records the algorithm + key ref', async () => {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof SignCommand) {
        return { Signature: new Uint8Array([1, 2, 3, 4]), KeyId: 'arn:aws:kms:us-east-1:1:key/abc' };
      }
      throw new Error('unexpected command');
    });
    const client = { send } as unknown as KMSClient;
    const signer = new KmsEvidenceManifestSigner(client, { keyId: 'alias/esign', signingAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256' });

    const signed = await signer.sign(MANIFEST, '2026-09-23T00:00:01.000Z');
    expect(send).toHaveBeenCalledTimes(1);
    expect(signed.signature).toBe(Buffer.from([1, 2, 3, 4]).toString('base64url'));
    expect(signed.signature_algorithm).toBe('KMS:RSASSA_PKCS1_V1_5_SHA_256');
    expect(signed.kms_key_version_ref).toBe('arn:aws:kms:us-east-1:1:key/abc');
    expect(signed.signing_timestamp).toBe('2026-09-23T00:00:01.000Z');
  });

  it('verifies via KMS VerifyCommand', async () => {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof VerifyCommand) return { SignatureValid: true };
      throw new Error('unexpected command');
    });
    const client = { send } as unknown as KMSClient;
    const signer = new KmsEvidenceManifestSigner(client, { keyId: 'alias/esign', signingAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256' });

    const ok = await signer.verify({
      manifest: MANIFEST,
      signature: 'AQIDBA',
      signature_algorithm: 'KMS:RSASSA_PKCS1_V1_5_SHA_256',
      kms_key_version_ref: 'alias/esign',
      signing_timestamp: '2026-09-23T00:00:01.000Z',
    });
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('env factory returns null when no KMS key is configured (software-signer fallback)', () => {
    expect(kmsEvidenceSignerFromEnv({})).toBeNull();
    expect(kmsEvidenceSignerFromEnv({ ESIGN_KMS_KEY_ID: '' })).toBeNull();
  });

  it('env factory builds a KMS signer when a key is configured', () => {
    const signer = kmsEvidenceSignerFromEnv({ ESIGN_KMS_KEY_ID: 'alias/esign', AWS_REGION: 'us-east-1' });
    expect(signer).toBeInstanceOf(KmsEvidenceManifestSigner);
  });
});
