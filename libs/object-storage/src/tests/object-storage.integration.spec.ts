import { Buffer } from 'node:buffer';

import {
  CreateBucketCommand,
  GetObjectAclCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketEncryptionCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { ObjectStorageService } from '../lib/object-storage.service.js';
import { S3ClientFactory } from '../lib/s3-client.factory.js';
import { parseResumeObjectKey } from '../lib/key-convention.js';
import { OBJECT_STORAGE_MAX_EXPIRY_SECONDS } from '../lib/object-storage.config.js';

// A8-3a §4 — integration proofs against LocalStack.
//
// Proves the substrate end-to-end:
//   1. Presigned PUT round-trip (the dormant Attachment.storage_key pattern, activated)
//   2. Presigned GET round-trip
//   3. Short expiry encoded into the signed URL (the PII-floor cap)
//   4. Private objects — signature-gated, never public-read
//   5. SSE-KMS / encryption metadata present
//   6. Tenant-scoped key convention round-trip
//   7. Access-log emission on PUT + GET
//   8. The activation: storage_key parses back to (tenant, talent_record, document_type, filename)
//   9. Caller-supplied expiry honored within cap

const TENANT_ID = '8f9e4c2a-6b1d-4d7e-8a9f-1c2b3d4e5f60';
const TALENT_RECORD_ID = '7e8d9c4a-5b6c-4a8e-9f1d-2a3b4c5d6e7f';
const BUCKET = 'aramo-test-resumes';
const REQ_ID = 'object-storage-integration';

const ENV_KEYS_TO_RESTORE = [
  'S3_RESUME_BUCKET',
  'AWS_REGION',
  'S3_ENDPOINT',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
] as const;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'A8-3a — ObjectStorageService integration (LocalStack)',
  () => {
    let localstack: StartedLocalStackContainer;
    let endpoint: string;
    let savedEnv: Partial<Record<(typeof ENV_KEYS_TO_RESTORE)[number], string | undefined>>;
    let service: ObjectStorageService;
    let factory: S3ClientFactory;
    let logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
    let adminClient: S3Client;

    beforeAll(async () => {
      localstack = await new LocalstackContainer('localstack/localstack:3').start();
      endpoint = localstack.getConnectionUri();

      savedEnv = {};
      for (const k of ENV_KEYS_TO_RESTORE) savedEnv[k] = process.env[k];

      process.env['S3_RESUME_BUCKET'] = BUCKET;
      process.env['AWS_REGION'] = 'us-east-1';
      process.env['S3_ENDPOINT'] = endpoint;
      process.env['AWS_ACCESS_KEY_ID'] = 'test';
      process.env['AWS_SECRET_ACCESS_KEY'] = 'test';

      adminClient = new S3Client({
        region: 'us-east-1',
        endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
      await adminClient.send(new CreateBucketCommand({ Bucket: BUCKET }));
      await adminClient.send(
        new PutPublicAccessBlockCommand({
          Bucket: BUCKET,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
        }),
      );
      await adminClient.send(
        new PutBucketEncryptionCommand({
          Bucket: BUCKET,
          ServerSideEncryptionConfiguration: {
            Rules: [
              {
                ApplyServerSideEncryptionByDefault: {
                  // LocalStack accepts SSE-S3 (AES256); SSE-KMS uses
                  // LocalStack's KMS, exercised at the bucket level via
                  // the terraform module under integration.
                  SSEAlgorithm: 'AES256',
                },
              },
            ],
          },
        }),
      );

      factory = new S3ClientFactory();
      logger = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      service = new ObjectStorageService(factory, logger as unknown as Parameters<typeof ObjectStorageService>[0]);
    }, 120_000);

    afterAll(async () => {
      for (const k of ENV_KEYS_TO_RESTORE) {
        if (savedEnv[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = savedEnv[k];
        }
      }
      await localstack?.stop();
    });

    it('§4.1 — presigned PUT round-trip: client uploads bytes; object exists at the expected key', async () => {
      const put = await service.createResumePresignedPut({
        tenant_id: TENANT_ID,
        talent_record_id: TALENT_RECORD_ID,
        filename: 'jane.pdf',
        content_type: 'application/pdf',
        requestId: REQ_ID,
      });
      expect(put.storage_key.startsWith(`${TENANT_ID}/talent/${TALENT_RECORD_ID}/resume/`)).toBe(true);
      expect(put.presigned_url).toContain(BUCKET);
      expect(put.expires_at).toMatch(/Z$/);

      const body = Buffer.from('%PDF-1.4 test bytes');
      const uploadRes = await fetch(put.presigned_url, {
        method: 'PUT',
        body,
        headers: { 'content-type': 'application/pdf' },
      });
      expect(uploadRes.ok).toBe(true);

      const head = await adminClient.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: put.storage_key }),
      );
      expect(head.ContentLength).toBe(body.byteLength);
    });

    it('§4.2 — presigned GET round-trip: downloaded bytes match uploaded bytes', async () => {
      const put = await service.createResumePresignedPut({
        tenant_id: TENANT_ID,
        talent_record_id: TALENT_RECORD_ID,
        filename: 'echo.pdf',
        content_type: 'application/pdf',
        requestId: REQ_ID,
      });
      const body = Buffer.from('round-trip-payload');
      await fetch(put.presigned_url, {
        method: 'PUT',
        body,
        headers: { 'content-type': 'application/pdf' },
      });

      const get = await service.createPresignedGet({
        storage_key: put.storage_key,
        requestId: REQ_ID,
      });
      const downloaded = await fetch(get.presigned_url, { method: 'GET' });
      expect(downloaded.ok).toBe(true);
      const buf = Buffer.from(await downloaded.arrayBuffer());
      expect(buf.equals(body)).toBe(true);
    });

    it('§4.3 — presigned PUT URL carries the requested (capped) short expiry', async () => {
      // Runtime enforcement of X-Amz-Expires (rejecting a request after the
      // window) is an S3 backend guarantee; LocalStack community does NOT emulate
      // it (an expired presigned PUT still returns 200 — verified), so asserting
      // "fetch after expiry fails" here is not demonstrable and was previously
      // green only because uploads were also broken. We assert the
      // PRODUCT-observable contract instead: the signed URL encodes the requested
      // short expiry (≤ the PII-floor cap), which a compliant backend (real S3)
      // then enforces. The cap itself is enforced at the service boundary by §4.3b.
      const put = await service.createResumePresignedPut({
        tenant_id: TENANT_ID,
        talent_record_id: TALENT_RECORD_ID,
        filename: 'expires.pdf',
        content_type: 'application/pdf',
        expires_in_seconds: 1,
        requestId: REQ_ID,
      });
      const expires = new URL(put.presigned_url).searchParams.get('X-Amz-Expires');
      expect(expires).toBe('1');
      expect(Number(expires)).toBeLessThanOrEqual(OBJECT_STORAGE_MAX_EXPIRY_SECONDS);
    });

    it('§4.3b — expiry above the PII-floor cap is rejected at the service boundary', async () => {
      await expect(
        service.createResumePresignedPut({
          tenant_id: TENANT_ID,
          talent_record_id: TALENT_RECORD_ID,
          filename: 'over-cap.pdf',
          content_type: 'application/pdf',
          expires_in_seconds: OBJECT_STORAGE_MAX_EXPIRY_SECONDS + 1,
          requestId: REQ_ID,
        }),
      ).rejects.toThrow(/exceeds the PII-floor cap/);
    });

    it('§4.4 — résumé objects are private: access is signature-gated and never public-read', async () => {
      // Denying an unsigned anonymous request is an S3/infra backend guarantee
      // (bucket BlockPublicAccess, provisioned by Terraform); LocalStack community
      // does not emulate it (an anonymous GET returns 200 even with
      // PutPublicAccessBlock set — verified). We assert the two PRODUCT-observable
      // responsibilities that keep résumés private:
      //   (a) the service only ever vends signature-gated URLs (never a bare
      //       public object URL), and
      //   (b) the upload sets no public-read ACL (no AllUsers grant on the object).
      const put = await service.createResumePresignedPut({
        tenant_id: TENANT_ID,
        talent_record_id: TALENT_RECORD_ID,
        filename: 'private.pdf',
        content_type: 'application/pdf',
        requestId: REQ_ID,
      });
      await fetch(put.presigned_url, {
        method: 'PUT',
        body: Buffer.from('private-bytes'),
        headers: { 'content-type': 'application/pdf' },
      });

      // (a) Read access is credentialed: the issued URL is SigV4-signed.
      const getUrl = new URL(
        (await service.createPresignedGet({ storage_key: put.storage_key, requestId: REQ_ID })).presigned_url,
      );
      expect(getUrl.searchParams.get('X-Amz-Signature')).toBeTruthy();
      expect(getUrl.searchParams.get('X-Amz-Credential')).toBeTruthy();

      // (b) The object is not world-readable: no AllUsers grant on its ACL.
      const acl = await adminClient.send(
        new GetObjectAclCommand({ Bucket: BUCKET, Key: put.storage_key }),
      );
      const isPublic = (acl.Grants ?? []).some(
        (g) => g.Grantee?.URI === 'http://acs.amazonaws.com/groups/global/AllUsers',
      );
      expect(isPublic).toBe(false);
    });

    it('§4.5 — uploaded objects carry server-side encryption metadata', async () => {
      const put = await service.createResumePresignedPut({
        tenant_id: TENANT_ID,
        talent_record_id: TALENT_RECORD_ID,
        filename: 'sse.pdf',
        content_type: 'application/pdf',
        requestId: REQ_ID,
      });
      await fetch(put.presigned_url, {
        method: 'PUT',
        body: Buffer.from('encrypted-payload'),
        headers: { 'content-type': 'application/pdf' },
      });
      const head = await adminClient.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: put.storage_key }),
      );
      expect(head.ServerSideEncryption).toBeDefined();
    });

    it('§4.6 — the tenant-scoped key parses back to its components (storage-side traceability)', async () => {
      const put = await service.createResumePresignedPut({
        tenant_id: TENANT_ID,
        talent_record_id: TALENT_RECORD_ID,
        filename: 'parseable.pdf',
        content_type: 'application/pdf',
        requestId: REQ_ID,
      });
      const parsed = parseResumeObjectKey(put.storage_key);
      expect(parsed).not.toBeNull();
      expect(parsed?.tenant_id).toBe(TENANT_ID);
      expect(parsed?.talent_record_id).toBe(TALENT_RECORD_ID);
      expect(parsed?.document_type).toBe('resume');
      expect(parsed?.filename).toBe('parseable.pdf');
    });

    it('§4.7 — every PUT/GET helper invocation emits an access-log entry; the raw talent_record_id is HASHED (Gate-5 review-item-3)', async () => {
      logger.log.mockClear();
      const put = await service.createResumePresignedPut({
        tenant_id: TENANT_ID,
        talent_record_id: TALENT_RECORD_ID,
        filename: 'logged.pdf',
        content_type: 'application/pdf',
        requestId: REQ_ID,
      });
      await service.createPresignedGet({
        storage_key: put.storage_key,
        requestId: REQ_ID,
      });

      const events = logger.log.mock.calls.map(
        (c) =>
          c[0] as {
            event: string;
            talent_record_id?: unknown;
            talent_record_id_hash?: string;
          },
      );
      const eventNames = events.map((e) => e.event);
      expect(eventNames).toContain('object_storage.presigned_put_issued');
      expect(eventNames).toContain('object_storage.presigned_get_issued');

      // The raw talent_record_id field MUST NOT appear in any emitted log.
      for (const e of events) {
        expect(e.talent_record_id).toBeUndefined();
      }

      // BOTH the PUT and the GET log MUST carry the hashed form (16
      // lowercase hex chars), with the SAME hash on both (same talent
      // → same correlation key).
      const putEvent = events.find(
        (e) => e.event === 'object_storage.presigned_put_issued',
      );
      const getEvent = events.find(
        (e) => e.event === 'object_storage.presigned_get_issued',
      );
      expect(putEvent?.talent_record_id_hash).toMatch(/^[0-9a-f]{16}$/);
      expect(getEvent?.talent_record_id_hash).toMatch(/^[0-9a-f]{16}$/);
      expect(putEvent?.talent_record_id_hash).toBe(getEvent?.talent_record_id_hash);

      // And the raw UUID must NOT appear inside the hashed form.
      expect(putEvent?.talent_record_id_hash).not.toContain(TALENT_RECORD_ID);
    });

    it('§4.8 — activation: storage_key returned IS the live S3 key (the dormant A4 pattern lives)', async () => {
      const put = await service.createResumePresignedPut({
        tenant_id: TENANT_ID,
        talent_record_id: TALENT_RECORD_ID,
        filename: 'activation.pdf',
        content_type: 'application/pdf',
        requestId: REQ_ID,
      });
      await fetch(put.presigned_url, {
        method: 'PUT',
        body: Buffer.from('activated'),
        headers: { 'content-type': 'application/pdf' },
      });

      // Direct admin GET against the very Key returned to the caller —
      // proves storage_key is the live S3 object identifier, not a
      // wrapper. THIS is the A4 pattern lit up.
      const obj = await adminClient.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: put.storage_key }),
      );
      const bytes = await obj.Body?.transformToByteArray();
      expect(bytes).toBeDefined();
      expect(Buffer.from(bytes ?? new Uint8Array()).toString('utf8')).toBe('activated');
    });

    it('§4.9 — caller-supplied expiry within the cap is honoured', async () => {
      const put = await service.createResumePresignedPut({
        tenant_id: TENANT_ID,
        talent_record_id: TALENT_RECORD_ID,
        filename: 'custom-expiry.pdf',
        content_type: 'application/pdf',
        expires_in_seconds: 120,
        requestId: REQ_ID,
      });
      const expiresMs = Date.parse(put.expires_at) - Date.now();
      expect(expiresMs).toBeGreaterThan(60_000);
      expect(expiresMs).toBeLessThan(125_000);
    });
  },
);
