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
import { IngestionModule } from '@aramo/ingestion';
import { SourcedTalentModule, SourcedTalentRepository } from '@aramo/sourced-talent';
import { CanonicalizationModule, CanonicalizationService } from '@aramo/canonicalization';
import {
  TalentTrustModule,
  TalentTrustService,
  TalentTrustRepository,
} from '@aramo/talent-trust';
import { TalentRecordModule } from '@aramo/talent-record';
import { ConsentModule } from '@aramo/consent';
import { ObjectStorageService } from '@aramo/object-storage';
import { TenantService } from '@aramo/identity';
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

// SRC-1 PR-3 — the full SRC-1 exit criterion end-to-end against real Postgres 17.
// Reuses the PR-2 harness (S3 + tenant fakes, ruled acceptable in the PR-2 Gate-6;
// real Postgres for the spine). The Cold-Ingest Extraction poll (which writes the
// declared identity evidence for EVERY sourced arrival, channel-agnostic) is out
// of SRC-1 scope; the spec seeds that evidence via TalentTrustService.recordEvidence
// to represent it — the promotion PATH is what PR-3 verifies carries the correct
// Indeed consent basis, not extraction.

const ROOT = resolve(__dirname, '../../../..');
const SECRET = 'src1-e2e-secret';
const TENANT_ID = '11111111-1111-7111-8111-1111111111e2';
const HOST = 'acme.aramo.ai';
const APPLY_ID = 'apply-e2e-001';

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
  'SRC-1 PR-3 — E2E closure: Indeed application → promotable record with indeed consent basis',
  () => {
    let container: StartedPostgreSqlContainer;
    let moduleRef: TestingModule;
    let app: INestApplication;
    let db: Client;
    let canonicalization: CanonicalizationService;
    let trust: TalentTrustService;
    let trustRepo: TalentTrustRepository;
    let arrivals: SourcedTalentRepository;
    let promotion: PromotionService;
    const savedEnv: Record<string, string | undefined> = {};

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
        return {
          storage_ref: `s3://fake/${input.tenant_id}/ingestion/${input.channel}/${input.external_source_id}.json`,
          sha256,
        };
      },
    };
    const fakeTenants = {
      findActiveBySlug: async (slug: string) =>
        slug === 'acme' ? { id: TENANT_ID } : null,
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
      process.env['ARAMO_IDENTITY_PEPPER'] = 'src1-e2e-pepper';
      process.env['ARAMO_IDENTITY_ADMISSION_POLICY'] = 'PORTABLE_ONLY';
      process.env['APP_ROOT_DOMAIN'] = 'aramo.ai';
      process.env[INDEED_APPLY_WEBHOOK_SECRET_ENV] = SECRET;

      moduleRef = await Test.createTestingModule({
        imports: [
          IngestionModule,
          SourcedTalentModule,
          CanonicalizationModule,
          TalentTrustModule,
          TalentRecordModule,
          ConsentModule,
        ],
        controllers: [IndeedApplyController],
        providers: [
          IndeedApplyWebhookService,
          PromotionService,
          { provide: ObjectStorageService, useValue: fakeStorage },
          { provide: TenantService, useValue: fakeTenants },
        ],
      }).compile();

      app = moduleRef.createNestApplication({ bodyParser: false });
      const http = app.getHttpAdapter().getInstance() as ReturnType<typeof express>;
      http.use(
        INDEED_APPLY_WEBHOOK_ROUTE,
        express.raw({ type: () => true, limit: INDEED_APPLY_MAX_BODY_BYTES }),
      );
      http.use(express.json());
      await app.init();

      canonicalization = moduleRef.get(CanonicalizationService);
      trust = moduleRef.get(TalentTrustService);
      trustRepo = moduleRef.get(TalentTrustRepository);
      arrivals = moduleRef.get(SourcedTalentRepository);
      promotion = moduleRef.get(PromotionService);

      db = new Client({ connectionString: url });
      await db.connect();
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    it('signed Indeed application traverses the whole SRC-1 spine to a promotable record with indeed consent basis', async () => {
      // ---- 1. signed application → webhook (raw-body HMAC path) ----
      const rawString = JSON.stringify({
        id: APPLY_ID,
        applicant: {
          fullName: 'Ada Lovelace',
          email: 'ada@example.com',
          phoneNumber: '4155550100',
        },
      });
      const res = await request(app.getHttpServer())
        .post(INDEED_APPLY_WEBHOOK_ROUTE)
        .set('Content-Type', 'application/json')
        .set('Host', HOST)
        .set('X-Indeed-Signature', computeIndeedSignature(Buffer.from(rawString, 'utf8'), SECRET))
        .send(rawString);
      // NB: PR-2's controller returns 200 {received:true} on success. The PR-3
      // relay describes it as "202"; asserting the shipped behavior (200) —
      // flagged as a typed divergence in Gate-6.
      expect(res.status).toBe(200);

      // ---- 2. RawPayloadReference (source 'indeed') ----
      const payload = await db.query(
        `SELECT id FROM "ingestion"."RawPayloadReference" WHERE tenant_id=$1 AND source='indeed'`,
        [TENANT_ID],
      );
      expect(payload.rows.length).toBe(1);
      const payloadId = payload.rows[0].id as string;

      // ---- 3. sourced_talent staging row (normalized + linkage provenance) ----
      const staging = await db.query(
        `SELECT normalized_email, provenance FROM "sourced_talent"."SourcedTalent"
          WHERE tenant_id=$1 AND source_channel='INDEED' AND external_source_id=$2`,
        [TENANT_ID, APPLY_ID],
      );
      expect(staging.rows.length).toBe(1);
      expect(staging.rows[0].normalized_email).toBe('ada@example.com');
      expect(staging.rows[0].provenance.ingestion_payload_id).toBe(payloadId);

      // ---- 4. canonicalize the document arrival → SOURCED_TALENT subject ----
      await canonicalization.canonicalize({
        payload_id: payloadId,
        source_channel: 'indeed',
        authContext: { tenant_id: TENANT_ID },
        requestId: 'e2e-canon',
      });
      const ref = await db.query(
        `SELECT subject_id FROM "talent_trust"."ResolutionSubjectRef"
          WHERE tenant_id=$1 AND ref_type='SOURCED_TALENT' AND ref_id=$2`,
        [TENANT_ID, payloadId],
      );
      expect(ref.rows.length).toBe(1);
      const subjectId = ref.rows[0].subject_id as string;

      // ---- 5. the subject appears in the sourcing-pool QUERY (repo-level) ----
      const pool = await trustRepo.listSourcedPool({ tenant_id: TENANT_ID, limit: 50 });
      expect(pool.some((r) => r.subject_id === subjectId)).toBe(true);

      // ---- 6. seed declared identity evidence (extraction proxy — channel-agnostic) ----
      await trust.recordEvidence({
        subjectRef: {
          tenant_id: TENANT_ID,
          ref_type: 'SOURCED_TALENT',
          ref_id: payloadId,
          link_source: 'src1-pr3-extraction-proxy',
        },
        dimension: 'IDENTITY',
        assertion_type: 'FULL_NAME',
        assertion_payload: { first_name: 'Ada', last_name: 'Lovelace' },
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'DURABLE',
        created_by: 'src1-pr3-test',
      });

      // ---- 7. promoteSubject → TalentRecord ----
      const outcome = await promotion.promoteSubject(
        { tenant_id: TENANT_ID, ref_type: 'SOURCED_TALENT', ref_id: payloadId },
        { requestId: 'e2e-promote' },
      );
      expect(outcome.status).toBe('promoted');
      const recordId =
        outcome.status === 'promoted' ? outcome.talent_record_id : '';
      const record = await db.query(
        `SELECT id, first_name, last_name FROM "talent_record"."TalentRecord" WHERE id=$1`,
        [recordId],
      );
      expect(record.rows.length).toBe(1);
      expect(record.rows[0].first_name).toBe('Ada');

      // ---- 8. consent grant carries source_basis { channel: indeed, class } ----
      const grants = await db.query(
        `SELECT metadata FROM "consent"."TalentConsentEvent"
          WHERE tenant_id=$1 AND talent_record_id=$2 AND action='granted'`,
        [TENANT_ID, recordId],
      );
      expect(grants.rows.length).toBeGreaterThan(0);
      const withBasis = grants.rows.find(
        (r) => r.metadata !== null && r.metadata.source_basis !== undefined,
      );
      expect(withBasis).toBeDefined();
      expect(withBasis.metadata.source_basis.channel).toBe('indeed');
      expect(withBasis.metadata.source_basis.source_class).toBe('THIRD_PARTY_UNVERIFIED');

      // ---- 9. dedup memory live: findArrival returns the staging row ----
      const found = await arrivals.findArrival(TENANT_ID, 'INDEED', APPLY_ID);
      expect(found).not.toBeNull();
      expect(found?.normalized_email).toBe('ada@example.com');
    });
  },
);
