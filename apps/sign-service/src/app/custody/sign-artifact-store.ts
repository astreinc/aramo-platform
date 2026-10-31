import { createHash } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';

import {
  SIGN_ARTIFACT_RETENTION_MODE,
  isSignSourceKey,
  loadSignArtifactStorageConfig,
  signCertificateKey,
  type SignArtifactStorageConfig,
} from './sign-artifact-storage.config.js';

// Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED, SX-2 — the
// S3 surface of the dedicated Sign artifact bucket. Separate client, separate
// credentials, separate bucket from @aramo/object-storage (the platform document
// bucket). Encryption is the bucket default (SSE-KMS with the Sign CMK); every
// completed artifact is written with a SHA-256 checksum S3 verifies on receipt and,
// only when a retention period is configured (LC-1), GOVERNANCE-mode Object Lock.
// Draft source deletes remove the CURRENT object only (a delete marker).
//
// Aramo-Sign-Retention-and-Purge-DocuSign-Parity-Directive-v0_1-LOCKED (ebd41d99) W3/W4 —
// purgeEnvelopeObjects() is the ONLY call that names a version id on delete: it removes
// every version (and delete marker) of one envelope's source/, executed/ and certificate/
// objects. It never touches evidence/ (LD-3: the evidence snapshot is kept), never sends
// BypassGovernanceRetention, and skips a version whose Object Lock retain-until is still
// in the future (reported as locked; R-16).

export const SIGN_ARTIFACT_MAX_BYTES = 52_428_800; // 50 MiB read ceiling.

export interface StoredArtifact {
  version_id: string;
  sha256: string;
  retain_until: Date | null;
}

export interface HeadedArtifact {
  version_id: string | null;
  /** base64 SHA-256 as S3 reports it (ChecksumMode ENABLED), when present. */
  checksum_sha256: string | null;
  retain_until: Date | null;
}

export type PurgeObjectKind = 'source' | 'executed' | 'certificate';

export interface PurgedObjectVersion {
  key: string;
  version_id: string;
}

export interface LockedObjectVersion extends PurgedObjectVersion {
  retain_until: Date;
}

export interface EnvelopeObjectPurgeResult {
  deleted: PurgedObjectVersion[];
  locked: LockedObjectVersion[];
}

const PURGE_KINDS: readonly PurgeObjectKind[] = ['source', 'executed', 'certificate'];

/** The tenants/<tenant>/envelopes/<envelope>/ prefix (UUID-validated by the key helpers). */
function signEnvelopeKeyPrefix(tenant_id: string, envelope_id: string): string {
  const probe = signCertificateKey(tenant_id, envelope_id, '0'.repeat(64));
  return probe.slice(0, probe.length - `certificate/${'0'.repeat(64)}.pdf`.length);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  const status = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}

export class SignArtifactStore {
  private cached: S3Client | null = null;

  constructor(
    readonly config: SignArtifactStorageConfig | null,
    private readonly clientFactory?: (config: SignArtifactStorageConfig) => S3Client,
  ) {}

  /** Boot-time construction: refuses (throws) on an invalid SIGN_ARTIFACT_* setting. */
  static fromEnv(env: NodeJS.ProcessEnv): SignArtifactStore {
    return new SignArtifactStore(loadSignArtifactStorageConfig(env));
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  get bucket(): string | null {
    return this.config?.bucket ?? null;
  }

  get retentionDays(): number | null {
    return this.config?.retentionDays ?? null;
  }

  private requireConfig(): SignArtifactStorageConfig {
    if (this.config === null) throw new Error('sign artifact storage is not configured (SIGN_ARTIFACT_BUCKET unset)');
    return this.config;
  }

  private client(): S3Client {
    if (this.cached !== null) return this.cached;
    const config = this.requireConfig();
    this.cached =
      this.clientFactory?.(config) ??
      new S3Client({
        region: config.region,
        forcePathStyle: config.forcePathStyle,
        // Checksums are sent explicitly (ChecksumSHA256) on artifact writes; keep the
        // SDK from adding its own default CRC32 on every other request.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        maxAttempts: 3,
        requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
        ...(config.endpoint !== null ? { endpoint: config.endpoint } : {}),
        ...(config.credentials !== null ? { credentials: config.credentials } : {}),
      });
    return this.cached;
  }

  /** Retain-until for an object written at `now`, or null when no retention is configured. */
  retainUntil(now: Date): Date | null {
    const days = this.retentionDays;
    return days === null ? null : new Date(now.getTime() + days * 86_400_000);
  }

  /** OWNED source upload. Never carries retention (draft delete must keep working). */
  async putSource(input: { key: string; body: Buffer; content_type: string }): Promise<{ version_id: string | null; sha256: string }> {
    if (!isSignSourceKey(input.key)) throw new Error('not a Sign source object key');
    const config = this.requireConfig();
    const sha256 = sha256Hex(input.body);
    const res = await this.client().send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.content_type,
        ChecksumAlgorithm: 'SHA256',
        ChecksumSHA256: hexToBase64(sha256),
      }),
    );
    return { version_id: res.VersionId ?? null, sha256 };
  }

  /**
   * Completed-artifact upload (executed PDF, certificate, evidence snapshot): SHA-256
   * checksum verified by S3, bucket-default SSE-KMS, and GOVERNANCE retention only when
   * configured. Requires a version id (the bucket is versioned; recovery is by version).
   */
  async putArtifact(input: { key: string; body: Buffer; content_type: string; sha256: string; now?: Date }): Promise<StoredArtifact> {
    const config = this.requireConfig();
    const retain_until = this.retainUntil(input.now ?? new Date());
    const params: PutObjectCommandInput = {
      Bucket: config.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.content_type,
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: hexToBase64(input.sha256),
      ...(retain_until !== null ? { ObjectLockMode: SIGN_ARTIFACT_RETENTION_MODE, ObjectLockRetainUntilDate: retain_until } : {}),
    };
    const res = await this.client().send(new PutObjectCommand(params));
    if (res.VersionId === undefined || res.VersionId === null || res.VersionId.length === 0 || res.VersionId === 'null') {
      throw new Error('sign artifact upload returned no version id (bucket versioning required)');
    }
    return { version_id: res.VersionId, sha256: input.sha256, retain_until };
  }

  /** HEAD with checksum mode; null when the key has no current object. */
  async head(key: string): Promise<HeadedArtifact | null> {
    const config = this.requireConfig();
    try {
      const res = await this.client().send(new HeadObjectCommand({ Bucket: config.bucket, Key: key, ChecksumMode: 'ENABLED' }));
      return {
        version_id: res.VersionId ?? null,
        checksum_sha256: res.ChecksumSHA256 ?? null,
        retain_until: res.ObjectLockRetainUntilDate ?? null,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** GET by key, or by an exact version id when given (recovery reads always pass one). */
  async get(key: string, version_id?: string, maxBytes: number = SIGN_ARTIFACT_MAX_BYTES): Promise<Buffer> {
    const config = this.requireConfig();
    const res = await this.client().send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key, ...(version_id !== undefined ? { VersionId: version_id } : {}) }),
    );
    const body = res.Body as { transformToByteArray(): Promise<Uint8Array> } | undefined;
    if (body === undefined) throw new Error('sign artifact read returned an empty body');
    const bytes = await body.transformToByteArray();
    if (bytes.byteLength > maxBytes) throw new Error('sign artifact exceeds the read ceiling');
    return Buffer.from(bytes);
  }

  /**
   * Retention and Purge W3/W4 — permanently deletes every version and delete marker of the
   * envelope's objects of the given kinds. Evidence is never listed. A version under an
   * unexpired Object Lock is skipped and returned in `locked`. Idempotent: a re-run lists
   * only what is left.
   */
  async purgeEnvelopeObjects(
    tenant_id: string,
    envelope_id: string,
    opts: { kinds: PurgeObjectKind[]; now?: Date },
  ): Promise<EnvelopeObjectPurgeResult> {
    const config = this.requireConfig();
    const now = opts.now ?? new Date();
    const base = signEnvelopeKeyPrefix(tenant_id, envelope_id);
    const result: EnvelopeObjectPurgeResult = { deleted: [], locked: [] };
    for (const kind of opts.kinds) {
      if (!PURGE_KINDS.includes(kind)) throw new Error(`not a purgeable Sign object kind: ${String(kind)}`);
      const prefix = `${base}${kind}/`;
      let keyMarker: string | undefined;
      let versionMarker: string | undefined;
      do {
        const page = await this.client().send(
          new ListObjectVersionsCommand({
            Bucket: config.bucket,
            Prefix: prefix,
            ...(keyMarker !== undefined ? { KeyMarker: keyMarker } : {}),
            ...(versionMarker !== undefined ? { VersionIdMarker: versionMarker } : {}),
          }),
        );
        const entries = [
          ...(page.Versions ?? []).map((v) => ({ key: v.Key, version_id: v.VersionId, marker: false })),
          ...(page.DeleteMarkers ?? []).map((m) => ({ key: m.Key, version_id: m.VersionId, marker: true })),
        ];
        for (const e of entries) {
          if (e.key === undefined || e.version_id === undefined || !e.key.startsWith(prefix)) continue;
          if (!e.marker) {
            const retain_until = await this.versionRetainUntil(e.key, e.version_id);
            if (retain_until !== null && retain_until.getTime() > now.getTime()) {
              result.locked.push({ key: e.key, version_id: e.version_id, retain_until });
              continue;
            }
          }
          await this.client().send(new DeleteObjectCommand({ Bucket: config.bucket, Key: e.key, VersionId: e.version_id }));
          result.deleted.push({ key: e.key, version_id: e.version_id });
        }
        const truncated = page.IsTruncated === true;
        keyMarker = truncated ? page.NextKeyMarker : undefined;
        versionMarker = truncated ? page.NextVersionIdMarker : undefined;
        if (truncated && keyMarker === undefined) throw new Error('sign artifact listing truncated without a continuation marker');
      } while (keyMarker !== undefined);
    }
    return result;
  }

  /** The version's Object Lock retain-until, or null when it carries none. */
  private async versionRetainUntil(key: string, version_id: string): Promise<Date | null> {
    const config = this.requireConfig();
    try {
      const res = await this.client().send(new GetObjectRetentionCommand({ Bucket: config.bucket, Key: key, VersionId: version_id }));
      return res.Retention?.RetainUntilDate ?? null;
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === 'NoSuchObjectLockConfiguration' || name === 'ObjectLockConfigurationNotFoundError' || isNotFound(err)) return null;
      throw err;
    }
  }

  /** Draft source delete: current object only (delete marker). Never a version delete. */
  async deleteSource(key: string): Promise<void> {
    if (!isSignSourceKey(key)) throw new Error('not a Sign source object key');
    const config = this.requireConfig();
    await this.client().send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
  }
}
