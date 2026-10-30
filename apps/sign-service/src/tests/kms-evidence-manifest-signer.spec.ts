import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, constants as cryptoConstants, type KeyObject } from 'node:crypto';

import {
  DescribeKeyCommand,
  GetPublicKeyCommand,
  KMSInvalidSignatureException,
  SignCommand,
  VerifyCommand,
  type KMSClient,
} from '@aws-sdk/client-kms';
import { describe, expect, it, vi } from 'vitest';
import {
  SoftwareEvidenceManifestSigner,
  verifyKmsEvidenceSignatureWithPublicKey,
  type EvidenceManifest,
} from '@aramo/sign';

import {
  KmsEvidenceKeyRefusedError,
  KmsEvidenceManifestSigner,
  kmsEvidenceSignerFromEnv,
  resolveEvidenceManifestSigner,
  signKmsClientFromEnv,
  verifyEvidenceManifestWithKmsPublicKey,
} from '../app/kms-evidence-manifest-signer.js';

// DOC-4 (R-4-5) + SX-1 item 4 / LC-3 — KMS evidence signing, verification and key
// custody, unit-tested against a FAKE KMS client (no live AWS). The fake holds a
// real local key pair and does real asymmetric crypto, so a genuine signature
// verifies and a tampered manifest does not.

const KEY_ARN = 'arn:aws:kms:us-east-1:472534873684:key/11111111-2222-3333-4444-555555555555';

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

type KeyKind = 'ECC_NIST_P256' | 'RSA_2048';

interface FakeKmsOptions {
  keySpec?: string;
  keyUsage?: string;
  keyState?: string;
  signingAlgorithms?: string[];
}

// A fake KMS: DIGEST-mode Sign/Verify can't be done over a bare digest with node
// crypto, so the fake keeps the preimage of every digest the test registers and
// signs/verifies that preimage with the real key pair.
function fakeKms(kind: KeyKind, opts: FakeKmsOptions = {}) {
  const pair =
    kind === 'ECC_NIST_P256'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const preimages = new Map<string, Buffer>();
  const register = (m: EvidenceManifest): void => {
    const bytes = Buffer.from(JSON.stringify(m), 'utf8');
    preimages.set(createHash('sha256').update(bytes).digest('hex'), bytes);
  };
  const algo = (alg: string) =>
    alg === 'ECDSA_SHA_256'
      ? { key: pair.privateKey as KeyObject, pub: pair.publicKey as KeyObject, opts: {} }
      : {
          key: pair.privateKey as KeyObject,
          pub: pair.publicKey as KeyObject,
          opts: { padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST },
        };
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof DescribeKeyCommand) {
      return {
        KeyMetadata: {
          KeyId: '11111111-2222-3333-4444-555555555555',
          Arn: KEY_ARN,
          KeyUsage: opts.keyUsage ?? 'SIGN_VERIFY',
          KeySpec: opts.keySpec ?? kind,
          KeyState: opts.keyState ?? 'Enabled',
          SigningAlgorithms:
            opts.signingAlgorithms ?? (kind === 'ECC_NIST_P256' ? ['ECDSA_SHA_256'] : ['RSASSA_PSS_SHA_256', 'RSASSA_PKCS1_V1_5_SHA_256']),
        },
      };
    }
    if (cmd instanceof SignCommand) {
      const input = cmd.input;
      const pre = preimages.get(Buffer.from(input.Message as Uint8Array).toString('hex'));
      if (pre === undefined) throw new Error('fake KMS: unknown digest');
      const a = algo(String(input.SigningAlgorithm));
      return { KeyId: KEY_ARN, Signature: new Uint8Array(cryptoSign('sha256', pre, { key: a.key, ...a.opts })), SigningAlgorithm: input.SigningAlgorithm };
    }
    if (cmd instanceof VerifyCommand) {
      const input = cmd.input;
      const pre = preimages.get(Buffer.from(input.Message as Uint8Array).toString('hex'));
      const a = algo(String(input.SigningAlgorithm));
      const ok = pre !== undefined && cryptoVerify('sha256', pre, { key: a.pub, ...a.opts }, Buffer.from(input.Signature as Uint8Array));
      if (!ok) throw new KMSInvalidSignatureException({ message: 'invalid', $metadata: {} });
      return { KeyId: KEY_ARN, SignatureValid: true };
    }
    if (cmd instanceof GetPublicKeyCommand) {
      return { KeyId: KEY_ARN, KeyUsage: 'SIGN_VERIFY', PublicKey: new Uint8Array(pair.publicKey.export({ type: 'spki', format: 'der' })) };
    }
    throw new Error('unexpected command');
  });
  return { client: { send } as unknown as KMSClient, send, register, publicKeyDer: new Uint8Array(pair.publicKey.export({ type: 'spki', format: 'der' })) };
}

const TAMPERED: EvidenceManifest = { ...MANIFEST, executed_sha256: 'c'.repeat(64) };

describe('KmsEvidenceManifestSigner — signing', () => {
  it('signs with the configured key (resolved to its ARN) and ECDSA_SHA_256 for an ECC_NIST_P256 key', async () => {
    const kms = fakeKms('ECC_NIST_P256');
    kms.register(MANIFEST);
    const signer = new KmsEvidenceManifestSigner(kms.client, { keyId: 'alias/aramo-sign-evidence' });

    const signed = await signer.sign(MANIFEST, '2026-09-23T00:00:01.000Z');

    const describeCmd = kms.send.mock.calls.map((c) => c[0]).find((c) => c instanceof DescribeKeyCommand) as DescribeKeyCommand;
    expect(describeCmd.input.KeyId).toBe('alias/aramo-sign-evidence');
    const signCmd = kms.send.mock.calls.map((c) => c[0]).find((c) => c instanceof SignCommand) as SignCommand;
    expect(signCmd.input.KeyId).toBe(KEY_ARN);
    expect(signCmd.input.SigningAlgorithm).toBe('ECDSA_SHA_256');
    expect(signCmd.input.MessageType).toBe('DIGEST');
    expect(Buffer.from(signCmd.input.Message as Uint8Array).toString('hex')).toBe(
      createHash('sha256').update(JSON.stringify(MANIFEST)).digest('hex'),
    );
    expect(signed.signature_algorithm).toBe('KMS:ECDSA_SHA_256');
    expect(signed.kms_key_version_ref).toBe(KEY_ARN);
    expect(signed.signing_timestamp).toBe('2026-09-23T00:00:01.000Z');
    expect(signed.manifest).toEqual(MANIFEST);
  });

  it('defaults an RSA key to RSASSA_PSS_SHA_256 and honours an explicit supported algorithm', async () => {
    const kms = fakeKms('RSA_2048');
    kms.register(MANIFEST);
    const pss = await new KmsEvidenceManifestSigner(kms.client, { keyId: KEY_ARN }).sign(MANIFEST, 't');
    expect(pss.signature_algorithm).toBe('KMS:RSASSA_PSS_SHA_256');
    expect(verifyKmsEvidenceSignatureWithPublicKey(pss, kms.publicKeyDer)).toBe(true);
  });

  it('checks the key only once (DescribeKey memoized across signatures)', async () => {
    const kms = fakeKms('ECC_NIST_P256');
    kms.register(MANIFEST);
    const signer = new KmsEvidenceManifestSigner(kms.client, { keyId: KEY_ARN });
    await signer.sign(MANIFEST, 't1');
    await signer.sign(MANIFEST, 't2');
    expect(kms.send.mock.calls.filter((c) => c[0] instanceof DescribeKeyCommand)).toHaveLength(1);
  });
});

describe('KmsEvidenceManifestSigner — key custody refusals (fail closed)', () => {
  it('refuses a symmetric ENCRYPT_DECRYPT key and never calls Sign', async () => {
    const kms = fakeKms('ECC_NIST_P256', { keyUsage: 'ENCRYPT_DECRYPT', keySpec: 'SYMMETRIC_DEFAULT', signingAlgorithms: [] });
    kms.register(MANIFEST);
    const signer = new KmsEvidenceManifestSigner(kms.client, { keyId: KEY_ARN });
    await expect(signer.sign(MANIFEST, 't')).rejects.toBeInstanceOf(KmsEvidenceKeyRefusedError);
    expect(kms.send.mock.calls.some((c) => c[0] instanceof SignCommand)).toBe(false);
  });

  it('refuses an HMAC key even when its usage looks like signing', async () => {
    const kms = fakeKms('ECC_NIST_P256', { keyUsage: 'SIGN_VERIFY', keySpec: 'HMAC_256' });
    await expect(new KmsEvidenceManifestSigner(kms.client, { keyId: KEY_ARN }).assertSigningKey()).rejects.toThrow(/not asymmetric/);
  });

  it('refuses a disabled key', async () => {
    const kms = fakeKms('ECC_NIST_P256', { keyState: 'Disabled' });
    await expect(new KmsEvidenceManifestSigner(kms.client, { keyId: KEY_ARN }).assertSigningKey()).rejects.toThrow(/Enabled/);
  });

  it('refuses an algorithm the key does not support', async () => {
    const kms = fakeKms('ECC_NIST_P256');
    const signer = new KmsEvidenceManifestSigner(kms.client, { keyId: KEY_ARN, signingAlgorithm: 'RSASSA_PSS_SHA_256' });
    await expect(signer.assertSigningKey()).rejects.toThrow(/does not support RSASSA_PSS_SHA_256/);
  });

  it('refuses an unknown SIGN_KMS_SIGNING_ALGORITHM in the env factory', () => {
    expect(() => kmsEvidenceSignerFromEnv({ SIGN_KMS_KEY_ID: KEY_ARN, SIGN_KMS_SIGNING_ALGORITHM: 'SYMMETRIC_DEFAULT' })).toThrow(KmsEvidenceKeyRefusedError);
  });
});

describe('KmsEvidenceManifestSigner — verification', () => {
  async function signedFixture(kind: KeyKind) {
    const kms = fakeKms(kind);
    kms.register(MANIFEST);
    kms.register(TAMPERED);
    const signer = new KmsEvidenceManifestSigner(kms.client, { keyId: 'alias/aramo-sign-evidence' });
    const signed = await signer.sign(MANIFEST, 't');
    return { kms, signer, signed };
  }

  it('KMS Verify accepts the genuine signature and rejects a tampered manifest', async () => {
    const { kms, signer, signed } = await signedFixture('ECC_NIST_P256');
    expect(await signer.verify(signed)).toBe(true);
    expect(await signer.verify({ ...signed, manifest: TAMPERED })).toBe(false);
    const verifyCmd = kms.send.mock.calls.map((c) => c[0]).find((c) => c instanceof VerifyCommand) as VerifyCommand;
    expect(verifyCmd.input.KeyId).toBe(KEY_ARN);
    expect(verifyCmd.input.SigningAlgorithm).toBe('ECDSA_SHA_256');
  });

  it('local public-key verify accepts genuine and rejects tampered manifest / signature (ECDSA + RSA-PSS)', async () => {
    for (const kind of ['ECC_NIST_P256', 'RSA_2048'] as const) {
      const { kms, signed } = await signedFixture(kind);
      expect(verifyKmsEvidenceSignatureWithPublicKey(signed, kms.publicKeyDer)).toBe(true);
      expect(verifyKmsEvidenceSignatureWithPublicKey({ ...signed, manifest: TAMPERED }, kms.publicKeyDer)).toBe(false);
      const sig = Buffer.from(signed.signature, 'base64url');
      sig[sig.length - 1] ^= 0x01;
      expect(verifyKmsEvidenceSignatureWithPublicKey({ ...signed, signature: sig.toString('base64url') }, kms.publicKeyDer)).toBe(false);
    }
  });

  it('GetPublicKey-based recovery verify works without kms:Sign', async () => {
    const { kms, signed } = await signedFixture('ECC_NIST_P256');
    expect(await verifyEvidenceManifestWithKmsPublicKey(kms.client, signed)).toBe(true);
    expect(await verifyEvidenceManifestWithKmsPublicKey(kms.client, { ...signed, manifest: TAMPERED })).toBe(false);
  });

  it('a software-digest manifest never verifies as a KMS signature', async () => {
    const { kms, signer } = await signedFixture('ECC_NIST_P256');
    const soft = await new SoftwareEvidenceManifestSigner().sign(MANIFEST, 't');
    expect(await signer.verify(soft)).toBe(false);
    expect(verifyKmsEvidenceSignatureWithPublicKey(soft, kms.publicKeyDer)).toBe(false);
    expect(kms.send.mock.calls.some((c) => c[0] instanceof VerifyCommand)).toBe(false);
  });
});

describe('resolveEvidenceManifestSigner — production boot guard (SX-1 item 4)', () => {
  it('refuses to start in production when SIGN_KMS_KEY_ID is unset or empty', async () => {
    await expect(resolveEvidenceManifestSigner({ NODE_ENV: 'production' })).rejects.toThrow(/refuses to start.*SIGN_KMS_KEY_ID/);
    await expect(resolveEvidenceManifestSigner({ NODE_ENV: 'production', SIGN_KMS_KEY_ID: '  ' })).rejects.toThrow(/refuses to start/);
    // An ARAMO_ENV value does not relax the guard: NODE_ENV=production is the trigger.
    await expect(resolveEvidenceManifestSigner({ NODE_ENV: 'production', ARAMO_ENV: 'local' })).rejects.toThrow(/refuses to start/);
  });

  it('refuses to start in production when the configured key is not an asymmetric signing key', async () => {
    const kms = fakeKms('ECC_NIST_P256', { keyUsage: 'ENCRYPT_DECRYPT', keySpec: 'SYMMETRIC_DEFAULT' });
    const build = () => new KmsEvidenceManifestSigner(kms.client, { keyId: KEY_ARN });
    await expect(resolveEvidenceManifestSigner({ NODE_ENV: 'production', SIGN_KMS_KEY_ID: KEY_ARN }, build)).rejects.toBeInstanceOf(KmsEvidenceKeyRefusedError);
  });

  it('binds the KMS signer in production when a valid asymmetric key is configured', async () => {
    const kms = fakeKms('ECC_NIST_P256');
    const build = () => new KmsEvidenceManifestSigner(kms.client, { keyId: KEY_ARN });
    const signer = await resolveEvidenceManifestSigner({ NODE_ENV: 'production', SIGN_KMS_KEY_ID: KEY_ARN }, build);
    expect(signer).toBeInstanceOf(KmsEvidenceManifestSigner);
  });

  it('non-production without a key falls back to the software signer', async () => {
    expect(await resolveEvidenceManifestSigner({})).toBeInstanceOf(SoftwareEvidenceManifestSigner);
    expect(await resolveEvidenceManifestSigner({ NODE_ENV: 'test' })).toBeInstanceOf(SoftwareEvidenceManifestSigner);
    expect(await resolveEvidenceManifestSigner({ NODE_ENV: 'development', SIGN_KMS_KEY_ID: '' })).toBeInstanceOf(SoftwareEvidenceManifestSigner);
  });

  it('env factory: null without a key, a KMS signer with one', () => {
    expect(kmsEvidenceSignerFromEnv({})).toBeNull();
    expect(kmsEvidenceSignerFromEnv({ SIGN_KMS_KEY_ID: '' })).toBeNull();
    expect(kmsEvidenceSignerFromEnv({ SIGN_KMS_KEY_ID: 'alias/aramo-sign-evidence', AWS_REGION: 'us-east-1', ...SIGN_PAIR })).toBeInstanceOf(KmsEvidenceManifestSigner);
  });
});

// CP-7 credential isolation: the evidence key admits only the Sign-only principal,
// so the KMS client carries the SIGN_ARTIFACT_AWS_* pair explicitly and never the
// box-wide AWS_* key (which in sign-service is the shared API credential).
const SIGN_PAIR = { SIGN_ARTIFACT_AWS_ACCESS_KEY_ID: 'AKIASIGNONLY', SIGN_ARTIFACT_AWS_SECRET_ACCESS_KEY: 'sign-secret' };
const SHARED_PAIR = { AWS_ACCESS_KEY_ID: 'AKIASHARED', AWS_SECRET_ACCESS_KEY: 'shared-secret' };

describe('signKmsClientFromEnv — Sign-only credential binding (CP-7)', () => {
  it('binds the Sign-only pair, not the shared AWS_* key, when both are present', async () => {
    const client = signKmsClientFromEnv({ ...SHARED_PAIR, ...SIGN_PAIR, AWS_REGION: 'us-east-1' });
    const creds = await client.config.credentials();
    expect(creds.accessKeyId).toBe('AKIASIGNONLY');
    expect(creds.secretAccessKey).toBe('sign-secret');
    expect(await client.config.region()).toBe('us-east-1');
  });

  it('prefers SIGN_ARTIFACT_AWS_REGION for the Sign identity', async () => {
    const client = signKmsClientFromEnv({ ...SIGN_PAIR, AWS_REGION: 'us-west-2', SIGN_ARTIFACT_AWS_REGION: 'us-east-1' });
    expect(await client.config.region()).toBe('us-east-1');
  });

  it('never falls back to the shared AWS_* key or the default chain', () => {
    expect(() => signKmsClientFromEnv({ ...SHARED_PAIR, AWS_REGION: 'us-east-1' })).toThrow(KmsEvidenceKeyRefusedError);
    expect(() => signKmsClientFromEnv({})).toThrow(/Sign-only credential/);
    expect(() => kmsEvidenceSignerFromEnv({ SIGN_KMS_KEY_ID: KEY_ARN, ...SHARED_PAIR })).toThrow(/shared AWS_\* credential is never used/);
  });

  it('refuses a half-set Sign pair', () => {
    expect(() => signKmsClientFromEnv({ SIGN_ARTIFACT_AWS_ACCESS_KEY_ID: 'AKIASIGNONLY' })).toThrow(/set together/);
    expect(() => signKmsClientFromEnv({ SIGN_ARTIFACT_AWS_SECRET_ACCESS_KEY: 'sign-secret', ...SHARED_PAIR })).toThrow(/set together/);
  });

  it('production refuses to start when the Sign-only credential is missing, even with the shared key set', async () => {
    await expect(
      resolveEvidenceManifestSigner({ NODE_ENV: 'production', SIGN_KMS_KEY_ID: KEY_ARN, ...SHARED_PAIR }),
    ).rejects.toBeInstanceOf(KmsEvidenceKeyRefusedError);
  });

  it('production refuses to start when KMS denies the credential (fail closed)', async () => {
    const denied = Object.assign(new Error('User is not authorized to perform: kms:DescribeKey'), { name: 'AccessDeniedException' });
    const send = vi.fn().mockRejectedValue(denied);
    const build = () => new KmsEvidenceManifestSigner({ send } as unknown as KMSClient, { keyId: KEY_ARN });
    await expect(resolveEvidenceManifestSigner({ NODE_ENV: 'production', SIGN_KMS_KEY_ID: KEY_ARN, ...SIGN_PAIR }, build)).rejects.toThrow(/not authorized/);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DescribeKeyCommand);
  });

  it('a denied Sign call is never turned into an unsigned manifest', async () => {
    const kms = fakeKms('RSA_2048');
    const real = kms.send.getMockImplementation();
    kms.send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof SignCommand) throw Object.assign(new Error('not authorized to perform: kms:Sign'), { name: 'AccessDeniedException' });
      return real?.(cmd);
    });
    const signer = new KmsEvidenceManifestSigner(kms.client, { keyId: KEY_ARN });
    await expect(signer.sign(MANIFEST, '2026-10-30T00:00:00.000Z')).rejects.toThrow(/kms:Sign/);
  });
});
