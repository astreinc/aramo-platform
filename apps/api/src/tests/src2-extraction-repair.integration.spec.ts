import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import express from 'express';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { Document, Packer, Paragraph } from 'docx';
import { AramoError } from '@aramo/common';
import { SourcedTalentModule } from '@aramo/sourced-talent';
import { CanonicalizationModule, CanonicalizationService } from '@aramo/canonicalization';
import { TalentTrustModule } from '@aramo/talent-trust';
import { TalentRecordModule } from '@aramo/talent-record';
import { ConsentModule } from '@aramo/consent';
import { ObjectStorageService, ObjectStorageModule } from '@aramo/object-storage';
import { TenantService } from '@aramo/identity';
import {
  IngestionModule,
  IngestionRepository,
  type ArrivalNeedingExtraction,
} from '@aramo/ingestion';
import {
  ColdIngestExtractionModule,
  ColdIngestExtractionProcessor,
  ColdIngestExtractionService,
} from '@aramo/cold-ingest-extraction';
import { extractResumeText } from '@aramo/resume-parse';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IndeedApplyController } from '../webhooks/indeed-apply.controller.js';
import { IndeedApplyWebhookService } from '../webhooks/indeed-apply.service.js';
import {
  INDEED_APPLY_MAX_BODY_BYTES,
  INDEED_APPLY_WEBHOOK_ROUTE,
  INDEED_APPLY_WEBHOOK_SECRET_ENV,
} from '../webhooks/indeed-apply.constants.js';
import { computeIndeedSignature } from '../webhooks/indeed-signature.js';
import { PromotionService } from '../talent-identity/promotion.service.js';

// SRC-2 PR-1 — extraction repair, end-to-end against real Postgres 17.
// The NON-SEEDED twin of src1-e2e-closure: a signed Indeed application whose
// payload CARRIES a base64 résumé promotes end-to-end with ZERO manual evidence
// seeding — the cold-ingest sweep parses the envelope and writes FULL_NAME. Plus
// the non-JSON regression, the résumé-less-envelope permanence, and a sweep-tick
// drain. ObjectStorage is a byte-STORING fake that serves `data:` URLs the real
// ResumeParserService fetches (no LocalStack; real Postgres for the spine).

const ROOT = resolve(__dirname, '../../../..');
const SECRET = 'src2-extraction-secret';
const TENANT_ID = '11111111-1111-7111-8111-1111111111f2';
const HOST = 'acme.aramo.ai';

const SAMPLE_RESUME_TEXT = [
  'Jane Smith',
  'jane.smith@example.com',
  '555-234-5678',
  '',
  'Skills',
  'TypeScript, React, Node.js',
].join('\n');

// A DOCX résumé (mammoth extraction) — deterministic and concurrency-safe, unlike
// pdf-parse/pdf.js on generated PDFs. detectResumeFormat sniffs the ZIP magic
// (PK\x03\x04), so the résumé's declared contentType is irrelevant to extraction.
async function makeResumeDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: SAMPLE_RESUME_TEXT.split('\n').map((text) => new Paragraph({ text })),
      },
    ],
  });
  return Packer.toBuffer(doc);
}
const RESUME_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = [
  ...migrationsFor('ingestion'),
  ...migrationsFor('canonicalization'),
  ...migrationsFor('identity-index'),
  ...migrationsFor('talent-trust'),
  ...migrationsFor('sourced-talent'),
  ...migrationsFor('talent-record'),
  ...migrationsFor('consent'),
];

function splitDdl(sql: string): string[] {
  const noLineComments = sql.replace(/--[^\n]*$/gm, '');
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < noLineComments.length; i++) {
    if (noLineComments.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    const ch = noLineComments[i];
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SRC-2 PR-1 — extraction repair (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let moduleRef: TestingModule;
    let app: INestApplication;
    let db: Client;
    let canonicalization: CanonicalizationService;
    let promotion: PromotionService;
    let processor: ColdIngestExtractionProcessor;
    let extraction: ColdIngestExtractionService;
    let ingestionRepo: IngestionRepository;
    const savedEnv: Record<string, string | undefined> = {};

    // Byte-STORING fake: putIngestionObject persists bytes under the bare key
    // (R11.1) and createPresignedGet serves them as a data: URL the real
    // ResumeParserService.fetchBytes reads.
    const objects = new Map<string, Buffer>();
    const fakeStorage = {
      putIngestionObject: async (input: {
        tenant_id: string;
        channel: string;
        external_source_id: string;
        body: Buffer;
        content_type: string;
        requestId: string;
      }): Promise<{ storage_ref: string; sha256: string }> => {
        const sha256 = createHash('sha256').update(input.body).digest('hex');
        const key = `${input.tenant_id}/ingestion/${input.channel.toLowerCase()}/${input.external_source_id}/${objects.size}.json`;
        objects.set(key, input.body);
        return { storage_ref: key, sha256 };
      },
      createPresignedGet: async ({ storage_key }: { storage_key: string; requestId: string }) => {
        const bytes = objects.get(storage_key);
        if (bytes === undefined) {
          throw new AramoError('OBJECT_STORAGE_UPLOAD_FAILED', `no object at ${storage_key}`, 502, {
            requestId: 'fake',
            details: { storage_key },
          });
        }
        return {
          presigned_url: `data:application/octet-stream;base64,${bytes.toString('base64')}`,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        };
      },
    };
    const fakeTenants = {
      findActiveBySlug: async (slug: string) => (slug === 'acme' ? { id: TENANT_ID } : null),
    };

    // Put an object into the fake store under a bare key; return the key.
    function seedObject(key: string, bytes: Buffer): string {
      objects.set(key, bytes);
      return key;
    }

    async function postWebhook(applyId: string, extraApplicant: Record<string, unknown> = {}): Promise<string> {
      const rawString = JSON.stringify({
        id: applyId,
        applicant: { fullName: 'Jane Smith', email: 'jane@x.co', ...extraApplicant },
      });
      const res = await request(app.getHttpServer())
        .post(INDEED_APPLY_WEBHOOK_ROUTE)
        .set('Content-Type', 'application/json')
        .set('Host', HOST)
        .set('X-Indeed-Signature', computeIndeedSignature(Buffer.from(rawString, 'utf8'), SECRET))
        .send(rawString);
      expect(res.status).toBe(200);
      const row = await db.query(
        `SELECT id FROM "ingestion"."RawPayloadReference" WHERE tenant_id=$1 AND source='indeed'
           ORDER BY created_at DESC LIMIT 1`,
        [TENANT_ID],
      );
      return row.rows[0].id as string;
    }

    async function arrivalFor(payloadId: string): Promise<ArrivalNeedingExtraction> {
      const r = await db.query(
        `SELECT id, tenant_id, storage_ref, resolved_subject_id, content_type
           FROM "ingestion"."RawPayloadReference" WHERE id=$1`,
        [payloadId],
      );
      const row = r.rows[0];
      return {
        id: row.id,
        tenant_id: row.tenant_id,
        storage_ref: row.storage_ref,
        resolved_subject_id: row.resolved_subject_id,
        content_type: row.content_type,
      };
    }

    const identityEvidence = async (subjectId: string, assertionType: string): Promise<number> => {
      const r = await db.query(
        `SELECT COUNT(*)::int AS c FROM "talent_trust"."EvidenceRecord"
           WHERE subject_id=$1 AND dimension='IDENTITY' AND assertion_type=$2 AND current_status='VALID'`,
        [subjectId, assertionType],
      );
      return r.rows[0].c;
    };

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new Client({ connectionString: url });
      await setup.connect();
      for (const p of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) {
          await setup.query(stmt);
        }
      }
      await setup.end();

      for (const k of [
        'DATABASE_URL',
        'ARAMO_IDENTITY_PEPPER',
        'ARAMO_IDENTITY_ADMISSION_POLICY',
        'APP_ROOT_DOMAIN',
        INDEED_APPLY_WEBHOOK_SECRET_ENV,
      ]) {
        savedEnv[k] = process.env[k];
      }
      process.env['DATABASE_URL'] = url;
      process.env['ARAMO_IDENTITY_PEPPER'] = 'src2-pepper';
      process.env['ARAMO_IDENTITY_ADMISSION_POLICY'] = 'PORTABLE_ONLY';
      process.env['APP_ROOT_DOMAIN'] = 'aramo.ai';
      process.env[INDEED_APPLY_WEBHOOK_SECRET_ENV] = SECRET;

      moduleRef = await Test.createTestingModule({
        imports: [
          // ObjectStorageModule at the root so ObjectStorageService is in root
          // scope for IndeedApplyWebhookService; overrideProvider below swaps the
          // real one for the fake GLOBALLY (incl. inside ResumeParseModule).
          ObjectStorageModule,
          ColdIngestExtractionModule, // pulls Ingestion + ResumeParse(+ObjectStorage) + TalentTrust
          // Imported directly too so their exports (IngestionService/Repository,
          // TalentTrustService/Repository) are in ROOT scope for the webhook +
          // PromotionService (ColdIngestExtractionModule imports but doesn't re-export).
          IngestionModule,
          TalentTrustModule,
          SourcedTalentModule,
          CanonicalizationModule,
          TalentRecordModule,
          ConsentModule,
        ],
        controllers: [IndeedApplyController],
        providers: [
          IndeedApplyWebhookService,
          PromotionService,
          { provide: TenantService, useValue: fakeTenants },
        ],
      })
        .overrideProvider(ObjectStorageService)
        .useValue(fakeStorage)
        .compile();

      app = moduleRef.createNestApplication({ bodyParser: false });
      const http = app.getHttpAdapter().getInstance() as ReturnType<typeof express>;
      http.use(
        INDEED_APPLY_WEBHOOK_ROUTE,
        express.raw({ type: () => true, limit: INDEED_APPLY_MAX_BODY_BYTES }),
      );
      http.use(express.json());
      await app.init();

      canonicalization = moduleRef.get(CanonicalizationService);
      promotion = moduleRef.get(PromotionService);
      processor = moduleRef.get(ColdIngestExtractionProcessor);
      extraction = moduleRef.get(ColdIngestExtractionService);
      ingestionRepo = moduleRef.get(IngestionRepository);

      db = new Client({ connectionString: url });
      await db.connect();

      // Warm the deterministic extractor once before the tests (defensive; the
      // fixture is DOCX/mammoth, which — unlike pdf-parse/pdf.js on generated PDFs
      // — is concurrency-safe and does not exhibit the cold-start empty-parse).
      // Bounded so it can never hang.
      const warm = await makeResumeDocx();
      let warmed = false;
      for (let i = 0; i < 60 && !warmed; i++) {
        const t = await extractResumeText(warm);
        warmed = t !== null && t.includes('Jane');
        if (!warmed) await new Promise((r) => setTimeout(r, 200));
      }
      expect(warmed).toBe(true);
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    it('NON-SEEDED: an Indeed application carrying a base64 résumé promotes end-to-end with zero manual evidence seeding', async () => {
      const docx = await makeResumeDocx();
      const payloadId = await postWebhook('apply-src2-001', {
        resume: { file: { data: docx.toString('base64'), fileName: 'jane.docx', contentType: RESUME_MIME } },
      });
      await canonicalization.canonicalize({
        payload_id: payloadId,
        source_channel: 'indeed',
        authContext: { tenant_id: TENANT_ID },
        requestId: 'src2-canon-1',
      });
      const arrival = await arrivalFor(payloadId);
      expect(arrival.content_type).toBe('application/json');

      // The sweep parses the JSON envelope → embedded résumé → FULL_NAME evidence.
      const outcome = await processor.drainBatch({ batchSize: 10, jobId: null });
      expect(outcome.extracted).toBeGreaterThanOrEqual(1);
      expect(await identityEvidence(arrival.resolved_subject_id, 'FULL_NAME')).toBeGreaterThanOrEqual(1);

      // Promote WITHOUT any recordEvidence seeding — the evidence came from extraction.
      const promoted = await promotion.promoteSubject(
        { tenant_id: TENANT_ID, ref_type: 'SOURCED_TALENT', ref_id: payloadId },
        { requestId: 'src2-promote-1' },
      );
      expect(promoted.status).toBe('promoted');
      const recordId = promoted.status === 'promoted' ? promoted.talent_record_id : '';
      const rec = await db.query(
        `SELECT first_name, last_name FROM "talent_record"."TalentRecord" WHERE id=$1`,
        [recordId],
      );
      expect(rec.rows[0].first_name).toBe('Jane');
      expect(rec.rows[0].last_name).toBe('Smith');
    });

    it('NON-JSON regression: a bare résumé-object arrival extracts byte-identically (FULL_NAME written)', async () => {
      // Seed a canonicalized arrival whose storage object IS a bare résumé file.
      const docx = await makeResumeDocx();
      const key = seedObject(`${TENANT_ID}/ingestion/github/nonjson-1/resume.docx`, docx);
      const payloadId = uuidv7();
      const subjectId = uuidv7();
      await db.query(
        `INSERT INTO "talent_trust"."ResolutionSubject" (id, tenant_id, status) VALUES ($1,$2,'ACTIVE')`,
        [subjectId, TENANT_ID],
      );
      await db.query(
        `INSERT INTO "ingestion"."RawPayloadReference"
           (id, tenant_id, source, source_class, storage_ref, sha256, content_type, captured_at, resolved_subject_id, updated_at)
         VALUES ($1,$2,'github','THIRD_PARTY_UNVERIFIED',$3,$4,$5,NOW(),$6,NOW())`,
        [payloadId, TENANT_ID, key, createHash('sha256').update(docx).digest('hex'), RESUME_MIME, subjectId],
      );

      const arrival: ArrivalNeedingExtraction = {
        id: payloadId,
        tenant_id: TENANT_ID,
        storage_ref: key,
        resolved_subject_id: subjectId,
        content_type: RESUME_MIME,
      };
      const result = await extraction.extractArrival(arrival);
      expect(result.outcome).toBe('extracted');
      expect(await identityEvidence(subjectId, 'FULL_NAME')).toBeGreaterThanOrEqual(1);
    });

    it('résumé-less JSON envelope → permanent done_no_identity, no crash', async () => {
      const payloadId = await postWebhook('apply-src2-noresume'); // no resume field
      await canonicalization.canonicalize({
        payload_id: payloadId,
        source_channel: 'indeed',
        authContext: { tenant_id: TENANT_ID },
        requestId: 'src2-canon-3',
      });
      const arrival = await arrivalFor(payloadId);
      const result = await extraction.extractArrival(arrival);
      expect(result.outcome).toBe('done_no_identity');
      const done = await db.query(
        `SELECT extraction_done_at FROM "ingestion"."RawPayloadReference" WHERE id=$1`,
        [payloadId],
      );
      expect(done.rows[0].extraction_done_at).not.toBeNull(); // permanently stamped
    });

    it('sweep tick drains a seeded batch (the queue-scheduled drain seam)', async () => {
      // Two fresh canonicalized JSON arrivals, both carrying a résumé.
      const docx = await makeResumeDocx();
      for (const n of ['drain-a', 'drain-b']) {
        const pid = await postWebhook(`apply-${n}`, {
          resume: { file: { data: docx.toString('base64'), fileName: 'r.docx', contentType: RESUME_MIME } },
        });
        await canonicalization.canonicalize({
          payload_id: pid,
          source_channel: 'indeed',
          authContext: { tenant_id: TENANT_ID },
          requestId: `src2-canon-${n}`,
        });
      }
      const before = await ingestionRepo.findArrivalsNeedingExtraction({ limit: 100, maxAttempts: 5 });
      expect(before.length).toBeGreaterThanOrEqual(2);

      const outcome = await processor.drainBatch({ batchSize: 100, jobId: 'test-tick' });
      expect(outcome.attempted).toBe(before.length);

      const after = await ingestionRepo.findArrivalsNeedingExtraction({ limit: 100, maxAttempts: 5 });
      expect(after.length).toBe(0); // all drained (extracted or done_no_identity → stamped)
    });
  },
);
