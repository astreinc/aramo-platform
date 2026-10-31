import { createHash } from 'node:crypto';

import type { S3Client } from '@aws-sdk/client-s3';

import { SignArtifactStore } from '../../app/custody/sign-artifact-store.js';
import type { SignArtifactStorageConfig } from '../../app/custody/sign-artifact-storage.config.js';

// An in-memory, versioned S3 double for the Sign artifact bucket. It records every
// command it receives (name + input) and models versioning, delete markers and the
// SHA-256 checksum S3 verifies on PutObject. Retention and Purge W3/W4: it also lists
// versions (paged by `listPageSize`), reports per-version retention, and deletes a named
// version — refusing (AccessDenied) a version whose Object Lock retain-until is in the
// future, as Governance mode does without the bypass header.

export interface FakeVersion {
  version_id: string;
  body: Buffer;
  checksum_sha256: string | null;
  retain_until: Date | null;
  delete_marker: boolean;
}

export class FakeSignS3 {
  readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  readonly objects = new Map<string, FakeVersion[]>();
  private seq = 0;
  /** When set, the next matching command rejects with this error. */
  failOn: { name: string; error: Error; times?: number } | null = null;
  versioning = true;
  /** Max entries per ListObjectVersions page (pagination). */
  listPageSize = 1000;
  /** The clock the fake's Object Lock compares retain-until against. */
  now: () => Date = () => new Date();

  readonly client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
      const name = command.constructor.name;
      this.calls.push({ name, input: command.input });
      if (this.failOn !== null && this.failOn.name === name) {
        const err = this.failOn.error;
        if (this.failOn.times === undefined || --this.failOn.times <= 0) this.failOn = null;
        throw err;
      }
      return this.handle(name, command.input);
    },
  } as unknown as S3Client;

  callsOf(name: string): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.name === name).map((c) => c.input);
  }

  current(key: string): FakeVersion | undefined {
    const v = this.objects.get(key);
    const last = v?.[v.length - 1];
    return last === undefined || last.delete_marker ? undefined : last;
  }

  seed(key: string, body: Buffer, opts: { checksum?: boolean; retain_until?: Date } = {}): string {
    const version_id = `v${++this.seq}`;
    const checksum = opts.checksum === false ? null : createHash('sha256').update(body).digest('base64');
    this.objects.set(key, [...(this.objects.get(key) ?? []), { version_id, body, checksum_sha256: checksum, retain_until: opts.retain_until ?? null, delete_marker: false }]);
    return version_id;
  }

  /** Every remaining version (incl. delete markers) under a key prefix. */
  versionsUnder(prefix: string): Array<{ key: string } & FakeVersion> {
    const out: Array<{ key: string } & FakeVersion> = [];
    for (const [key, versions] of [...this.objects.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (key.startsWith(prefix)) for (const v of versions) out.push({ key, ...v });
    }
    return out;
  }

  private notFound(): Error {
    return Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
  }

  private handle(name: string, input: Record<string, unknown>): unknown {
    const key = input['Key'] as string;
    switch (name) {
      case 'PutObjectCommand': {
        const body = input['Body'] as Buffer;
        const actual = createHash('sha256').update(body).digest('base64');
        if (input['ChecksumSHA256'] !== undefined && input['ChecksumSHA256'] !== actual) {
          throw Object.assign(new Error('BadDigest'), { name: 'BadDigest' });
        }
        const version_id = this.versioning ? `v${++this.seq}` : undefined;
        this.objects.set(key, [
          ...(this.objects.get(key) ?? []),
          {
            version_id: version_id ?? 'null',
            body,
            checksum_sha256: input['ChecksumSHA256'] !== undefined ? actual : null,
            retain_until: (input['ObjectLockRetainUntilDate'] as Date | undefined) ?? null,
            delete_marker: false,
          },
        ]);
        return { VersionId: version_id };
      }
      case 'HeadObjectCommand': {
        const cur = this.current(key);
        if (cur === undefined) throw this.notFound();
        return { VersionId: cur.version_id, ChecksumSHA256: cur.checksum_sha256 ?? undefined, ObjectLockRetainUntilDate: cur.retain_until ?? undefined };
      }
      case 'GetObjectCommand': {
        const vid = input['VersionId'] as string | undefined;
        const v = vid !== undefined ? this.objects.get(key)?.find((x) => x.version_id === vid && !x.delete_marker) : this.current(key);
        if (v === undefined) throw Object.assign(new Error('NoSuchVersion'), { name: vid !== undefined ? 'NoSuchVersion' : 'NoSuchKey' });
        return { Body: { transformToByteArray: async () => new Uint8Array(v.body) } };
      }
      case 'DeleteObjectCommand': {
        const vid = input['VersionId'] as string | undefined;
        if (vid !== undefined) {
          if (input['BypassGovernanceRetention'] !== undefined) throw new Error('fake: BypassGovernanceRetention was sent');
          const versions = this.objects.get(key) ?? [];
          const v = versions.find((x) => x.version_id === vid);
          if (v === undefined) return {};
          if (v.retain_until !== null && v.retain_until.getTime() > this.now().getTime()) {
            throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
          }
          const left = versions.filter((x) => x.version_id !== vid);
          if (left.length === 0) this.objects.delete(key);
          else this.objects.set(key, left);
          return { VersionId: vid, DeleteMarker: v.delete_marker };
        }
        this.objects.set(key, [...(this.objects.get(key) ?? []), { version_id: `dm${++this.seq}`, body: Buffer.alloc(0), checksum_sha256: null, retain_until: null, delete_marker: true }]);
        return {};
      }
      case 'ListObjectVersionsCommand': {
        const prefix = (input['Prefix'] as string | undefined) ?? '';
        const all = this.versionsUnder(prefix);
        const keyMarker = input['KeyMarker'] as string | undefined;
        const vidMarker = input['VersionIdMarker'] as string | undefined;
        // Markers are positions (as in S3), so entries deleted since the last page do not
        // shift the listing: keep everything strictly after (keyMarker, versionMarker).
        const seqOf = (vid: string | undefined): number => Number((vid ?? '').replace(/^\D+/, '')) || 0;
        const after = keyMarker === undefined
          ? all
          : all.filter((v) => v.key > keyMarker || (v.key === keyMarker && seqOf(v.version_id) > seqOf(vidMarker)));
        const page = after.slice(0, this.listPageSize);
        const truncated = this.listPageSize < after.length;
        const last = page[page.length - 1];
        return {
          Versions: page.filter((v) => !v.delete_marker).map((v) => ({ Key: v.key, VersionId: v.version_id })),
          DeleteMarkers: page.filter((v) => v.delete_marker).map((v) => ({ Key: v.key, VersionId: v.version_id })),
          IsTruncated: truncated,
          ...(truncated && last !== undefined ? { NextKeyMarker: last.key, NextVersionIdMarker: last.version_id } : {}),
        };
      }
      case 'GetObjectRetentionCommand': {
        const v = this.objects.get(key)?.find((x) => x.version_id === input['VersionId']);
        if (v === undefined) throw this.notFound();
        if (v.retain_until === null) throw Object.assign(new Error('NoSuchObjectLockConfiguration'), { name: 'NoSuchObjectLockConfiguration', $metadata: { httpStatusCode: 404 } });
        return { Retention: { Mode: 'GOVERNANCE', RetainUntilDate: v.retain_until } };
      }
      default:
        throw new Error(`fake: unsupported ${name}`);
    }
  }
}

export const TEST_SIGN_BUCKET = 'aramo-test-sign-artifacts';

export function fakeStore(fake: FakeSignS3, overrides: Partial<SignArtifactStorageConfig> = {}): SignArtifactStore {
  const config: SignArtifactStorageConfig = {
    bucket: TEST_SIGN_BUCKET,
    region: 'us-east-1',
    endpoint: null,
    forcePathStyle: false,
    credentials: null,
    retentionDays: null,
    ...overrides,
  };
  return new SignArtifactStore(config, () => fake.client);
}
