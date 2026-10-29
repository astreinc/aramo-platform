// SX-0 pure checks (no database): canonical digest, key parsing, S3 guards and batching,
// and the command line's refusals. The database behaviour is in sx0.integration.spec.ts.
//   npx vitest run --config tools/vitest.config.ts sign-sx0-cleanup

import { describe, expect, it } from 'vitest';

import { main } from './sx0.js';
import {
  S3_EXECUTION_ENV,
  S3_MANIFEST_KIND,
  type S3Manifest,
  type S3ManifestBody,
  type S3Port,
  Sx0Refusal,
  assertS3ExecutionAuthorized,
  canonicalJson,
  digest,
  executeS3Deletes,
  parseSourceKey,
  scopedPrefix,
} from './sx0.lib.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ENV = '22222222-2222-4222-8222-222222222222';

function s3Manifest(keys: string[], prefix = scopedPrefix(TENANT)): S3Manifest {
  const body: S3ManifestBody = {
    kind: S3_MANIFEST_KIND,
    version: 1,
    db_manifest_sha256: 'a'.repeat(64),
    bucket: 'b',
    prefix,
    versions: keys.map((key, i) => ({ key, version_id: `v${i}`, is_delete_marker: false, is_latest: true, size: 1, last_modified: null, classification: 'ORPHAN_NO_ENVELOPE' })),
    key_counts: {},
    version_count: keys.length,
    delete_marker_count: 0,
    excluded_retained_keys: [],
  };
  return { s3_manifest_sha256: digest(body), generated_at: 'x', body };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof Sx0Refusal ? e.code : `non-refusal: ${String(e)}`;
  }
  return undefined;
}

describe('SX-0 pure checks', () => {
  it('canonical JSON is key-order independent, so the digest is stable', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(digest({ x: 1, y: 2 })).toBe(digest({ y: 2, x: 1 }));
    expect(digest({ x: 1 })).not.toBe(digest({ x: 2 }));
  });

  it('parses esign/source/<tenant>/<envelope>/<object> and nothing else', () => {
    expect(parseSourceKey(`esign/source/${TENANT}/${ENV}/obj`)).toEqual({ tenant: TENANT, envelope: ENV });
    expect(parseSourceKey(`documents/${TENANT}/x`)).toBeNull();
    expect(parseSourceKey(`esign/source/${TENANT}`)).toBeNull();
  });

  it('the S3 step refuses any key outside esign/source/<tenant>/, a path escape, or an unversioned entry', () => {
    const ok = s3Manifest([`esign/source/${TENANT}/${ENV}/o1`]);
    const auth = (m: S3Manifest) => () => assertS3ExecutionAuthorized({ manifest: m, manifestSha256: m.s3_manifest_sha256, bucket: 'b', env: { [S3_EXECUTION_ENV]: m.s3_manifest_sha256 } });
    expect(codeOf(auth(ok))).toBeUndefined();
    expect(codeOf(auth(s3Manifest([`documents/${TENANT}/x.pdf`])))).toBe('OUT_OF_PREFIX');
    expect(codeOf(auth(s3Manifest([`esign/source/${ENV}/${ENV}/o1`])))).toBe('OUT_OF_PREFIX');
    expect(codeOf(auth(s3Manifest([`esign/source/${TENANT}/../../documents/x`])))).toBe('OUT_OF_PREFIX');
    expect(codeOf(auth(s3Manifest(['resumes/x'], 'resumes/')))).toBe('OUT_OF_PREFIX');
    const unversioned = s3Manifest([`esign/source/${TENANT}/${ENV}/o1`]);
    (unversioned.body.versions[0] as { version_id: string }).version_id = 'null';
    unversioned.s3_manifest_sha256 = digest(unversioned.body);
    expect(codeOf(auth(unversioned))).toBe('BAD_MANIFEST');
    expect(codeOf(() => assertS3ExecutionAuthorized({ manifest: ok, manifestSha256: ok.s3_manifest_sha256, bucket: 'b', env: {} }))).toBe('NOT_AUTHORIZED');
  });

  it('deletes in batches of at most 1000, always with a VersionId, and reports per-version errors', async () => {
    const keys = Array.from({ length: 2001 }, (_, i) => `esign/source/${TENANT}/${ENV}/o${i}`);
    const calls: number[] = [];
    const s3: S3Port = {
      listObjectVersions: async () => ({}),
      deleteObjects: async (input) => {
        calls.push(input.Delete.Objects.length);
        expect(input.Delete.Objects.every((o) => o.VersionId.length > 0)).toBe(true);
        const [first, ...rest] = input.Delete.Objects;
        return {
          Deleted: rest.map((o) => ({ Key: o.Key, VersionId: o.VersionId })),
          Errors: first === undefined ? [] : [{ Key: first.Key, VersionId: first.VersionId, Code: 'AccessDenied', Message: 'no' }],
        };
      },
    };
    const r = await executeS3Deletes(s3, s3Manifest(keys));
    expect(calls).toEqual([1000, 1000, 1]);
    expect(r.requested).toBe(2001);
    expect(r.errors).toHaveLength(3);
    expect(r.deleted).toHaveLength(1998);
  });

  it('the command line refuses unknown modes, bad tenants and a missing DATABASE_URL', async () => {
    await expect(main(['wipe'])).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    await expect(main(['inventory', '--tenant', 'not-a-uuid'])).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    await expect(main(['execute'])).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    const saved = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    try {
      await expect(main(['inventory', '--tenant', TENANT])).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    } finally {
      if (saved !== undefined) process.env['DATABASE_URL'] = saved;
    }
  });
});
