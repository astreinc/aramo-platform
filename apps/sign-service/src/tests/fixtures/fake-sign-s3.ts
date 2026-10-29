import { createHash } from 'node:crypto';

import type { S3Client } from '@aws-sdk/client-s3';

import { SignArtifactStore } from '../../app/custody/sign-artifact-store.js';
import type { SignArtifactStorageConfig } from '../../app/custody/sign-artifact-storage.config.js';

// An in-memory, versioned S3 double for the Sign artifact bucket. It records every
// command it receives (name + input) and models versioning, delete markers and the
// SHA-256 checksum S3 verifies on PutObject.

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

  seed(key: string, body: Buffer, opts: { checksum?: boolean } = {}): string {
    const version_id = `v${++this.seq}`;
    const checksum = opts.checksum === false ? null : createHash('sha256').update(body).digest('base64');
    this.objects.set(key, [...(this.objects.get(key) ?? []), { version_id, body, checksum_sha256: checksum, retain_until: null, delete_marker: false }]);
    return version_id;
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
        if (input['VersionId'] !== undefined) throw new Error('fake: a version delete was attempted');
        this.objects.set(key, [...(this.objects.get(key) ?? []), { version_id: `dm${++this.seq}`, body: Buffer.alloc(0), checksum_sha256: null, retain_until: null, delete_marker: true }]);
        return {};
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
