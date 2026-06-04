import { Buffer } from 'node:buffer';

import {
  CreateBucketCommand,
  GetObjectTaggingCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  LocalstackContainer,
  type StartedLocalStackContainer,
} from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Document, Packer, Paragraph } from 'docx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  ObjectStorageService,
  ORPHAN_SWEEP_TAG_KEY,
  ORPHAN_SWEEP_TAG_VALUE_COMMITTED,
  ORPHAN_SWEEP_TAG_VALUE_PENDING,
  S3ClientFactory,
} from '@aramo/object-storage';

import { ResumeParserService } from '../lib/resume-parser.service.js';

// A8-3b — integration proofs for the résumé-parse flow against LocalStack.
//
// Proves (the directive §6 list, mapped):
//   #1 presigned-upload flow (E1): PUT URL works + tag baked
//   #2 parse-to-prefill happy: PDF fixture → prefill + status='parsed'
//   #2 parse-to-prefill happy: DOCX fixture → prefill + status='parsed'
//   #4 parse-failure non-blocking: malformed file → 200 + status='failed'
//   #(orphan-sweep): markResumeCommitted replaces orphan-pending tag with committed
//
// Proofs #5 (no-Core-Talent boundary), #6 (attachment link), #7 (no
// TalentDocument materialized), #8 (R10/vocab), #9 (A2 guard chain),
// and #10 (full sweep) are exercised at apps/api integration scope or
// at the cascade-gate level -- this spec scopes to libs/resume-parse +
// libs/object-storage interplay.

const TENANT_ID = '8f9e4c2a-6b1d-4d7e-8a9f-1c2b3d4e5f60';
const DRAFT_PARTITION_ID = '7e8d9c4a-5b6c-4a8e-9f1d-2a3b4c5d6e7f';
const BUCKET = 'aramo-test-resumes';
const REQ_ID = 'resume-parse-integration';

const ENV_KEYS_TO_RESTORE = [
  'S3_RESUME_BUCKET',
  'AWS_REGION',
  'S3_ENDPOINT',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
] as const;

const SAMPLE_TEXT = [
  'Jane Smith',
  'jane.smith@example.com',
  '555-234-5678',
  '',
  'Skills',
  'TypeScript, React, Node.js, PostgreSQL',
  '',
  'Experience',
  'Acme Corp 2022-Present',
].join('\n');

async function makeSamplePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = SAMPLE_TEXT.split('\n');
  let y = 750;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 12, font });
    y -= 20;
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

async function makeSampleDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: SAMPLE_TEXT.split('\n').map(
          (text) => new Paragraph({ text }),
        ),
      },
    ],
  });
  return Packer.toBuffer(doc);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'A8-3b — résumé parse integration (LocalStack)',
  () => {
    let localstack: StartedLocalStackContainer;
    let endpoint: string;
    let savedEnv: Partial<
      Record<(typeof ENV_KEYS_TO_RESTORE)[number], string | undefined>
    >;
    let objectStorage: ObjectStorageService;
    let parser: ResumeParserService;
    let adminClient: S3Client;
    let pdfBuffer: Buffer;
    let docxBuffer: Buffer;

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

      // Build the substrate the same way the production module would,
      // but with the LocalStack-pointing env vars active.
      const factory = new S3ClientFactory();
      const logger = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      objectStorage = new ObjectStorageService(factory, logger);
      parser = new ResumeParserService(objectStorage, logger);

      pdfBuffer = await makeSamplePdf();
      docxBuffer = await makeSampleDocx();
    }, 120_000);

    afterAll(async () => {
      for (const k of ENV_KEYS_TO_RESTORE) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      await localstack?.stop();
    });

    it('proof #1 — presigned PUT URL is created and works (round-trip via fetch)', async () => {
      const { storage_key, presigned_url, expires_at } =
        await objectStorage.createResumePresignedPut({
          tenant_id: TENANT_ID,
          talent_record_id: DRAFT_PARTITION_ID,
          filename: 'resume.pdf',
          content_type: 'application/pdf',
          requestId: REQ_ID,
        });
      expect(storage_key).toContain(TENANT_ID);
      expect(presigned_url).toMatch(/^https?:\/\//);
      expect(new Date(expires_at).getTime()).toBeGreaterThan(Date.now());

      // The URL must carry x-amz-tagging in its signed query string
      // (the orphan-sweep tag baked into the signed payload).
      expect(presigned_url).toContain('x-amz-tagging');
      expect(decodeURIComponent(presigned_url)).toContain(
        `${ORPHAN_SWEEP_TAG_KEY}=${ORPHAN_SWEEP_TAG_VALUE_PENDING}`,
      );

      // Round-trip the PUT through the signed URL with the matching tag header.
      const putResp = await fetch(presigned_url, {
        method: 'PUT',
        headers: {
          'content-type': 'application/pdf',
          'x-amz-tagging': `${ORPHAN_SWEEP_TAG_KEY}=${ORPHAN_SWEEP_TAG_VALUE_PENDING}`,
        },
        body: pdfBuffer,
      });
      expect(putResp.ok).toBe(true);

      // Verify the object now carries the orphan-pending tag.
      const tagging = await adminClient.send(
        new GetObjectTaggingCommand({ Bucket: BUCKET, Key: storage_key }),
      );
      const tags = (tagging.TagSet ?? []).map((t) => `${t.Key}=${t.Value}`);
      expect(tags).toContain(
        `${ORPHAN_SWEEP_TAG_KEY}=${ORPHAN_SWEEP_TAG_VALUE_PENDING}`,
      );
    });

    it('proof #2 — PDF résumé parses to prefill with parse_status=parsed', async () => {
      const storageKey = `${TENANT_ID}/talent/${DRAFT_PARTITION_ID}/resume/parse-pdf.pdf`;
      await adminClient.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: storageKey,
          Body: pdfBuffer,
          ContentType: 'application/pdf',
        }),
      );

      const result = await parser.parseFromStorageKey({
        storage_key: storageKey,
        requestId: REQ_ID,
      });

      expect(result.parse_status).toBe('parsed');
      expect(result.prefill.first_name).toBe('Jane');
      expect(result.prefill.last_name).toBe('Smith');
      expect(result.prefill.email1).toBe('jane.smith@example.com');
      expect(result.prefill.phone_cell).toBe('555-234-5678');
    });

    it('proof #2 — DOCX résumé parses to prefill with parse_status=parsed', async () => {
      const storageKey = `${TENANT_ID}/talent/${DRAFT_PARTITION_ID}/resume/parse-docx.docx`;
      await adminClient.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: storageKey,
          Body: docxBuffer,
          ContentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      );

      const result = await parser.parseFromStorageKey({
        storage_key: storageKey,
        requestId: REQ_ID,
      });

      expect(result.parse_status).toBe('parsed');
      expect(result.prefill.first_name).toBe('Jane');
      expect(result.prefill.email1).toBe('jane.smith@example.com');
    });

    it('proof #4 — parse-failure is NON-BLOCKING (malformed file → 200 + status=failed, empty prefill)', async () => {
      const storageKey = `${TENANT_ID}/talent/${DRAFT_PARTITION_ID}/resume/malformed.txt`;
      await adminClient.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: storageKey,
          Body: Buffer.from('not a real résumé, just text', 'utf8'),
        }),
      );

      // The parser MUST NOT throw on parse-failure; it returns failed status.
      const result = await parser.parseFromStorageKey({
        storage_key: storageKey,
        requestId: REQ_ID,
      });

      expect(result.parse_status).toBe('failed');
      expect(result.prefill).toEqual({});
    });

    it('orphan-sweep — markResumeCommitted replaces orphan-pending tag with committed', async () => {
      const storageKey = `${TENANT_ID}/talent/${DRAFT_PARTITION_ID}/resume/tag-clear.pdf`;
      // Seed the object with the orphan-pending tag (as if uploaded via E1).
      await adminClient.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: storageKey,
          Body: pdfBuffer,
          ContentType: 'application/pdf',
          Tagging: `${ORPHAN_SWEEP_TAG_KEY}=${ORPHAN_SWEEP_TAG_VALUE_PENDING}`,
        }),
      );

      await objectStorage.markResumeCommitted({
        storage_key: storageKey,
        requestId: REQ_ID,
      });

      const tagging = await adminClient.send(
        new GetObjectTaggingCommand({ Bucket: BUCKET, Key: storageKey }),
      );
      const tags = (tagging.TagSet ?? []).map((t) => `${t.Key}=${t.Value}`);
      expect(tags).toContain(
        `${ORPHAN_SWEEP_TAG_KEY}=${ORPHAN_SWEEP_TAG_VALUE_COMMITTED}`,
      );
      expect(tags).not.toContain(
        `${ORPHAN_SWEEP_TAG_KEY}=${ORPHAN_SWEEP_TAG_VALUE_PENDING}`,
      );
    });
  },
);
