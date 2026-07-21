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
import { normalizeEmail, normalizePhone } from '@aramo/common';
import { IngestionModule } from '@aramo/ingestion';
import { SourcedTalentModule } from '@aramo/sourced-talent';
import { CanonicalizationModule } from '@aramo/canonicalization';
import { CanonicalizationService } from '@aramo/canonicalization';
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

// SRC-1 PR-2 — Indeed Apply webhook, full spine against real Postgres 17.
//
// Real: IngestionService (RawPayloadReference), SourcedTalentRepository (staging
// dedup memory), CanonicalizationService (mints the SOURCED_TALENT subject ref).
// Faked: ObjectStorageService (no LocalStack precedent in apps/api — the real S3
// write is unit-covered in libs/object-storage/put-ingestion-object.spec.ts; the
// fake computes the SAME server-side sha256 so acceptPayload's dedup is real) and
// TenantService (Host→tenant is unit-covered; the identity schema is out of scope
// here). Drives the HTTP path (route-scoped raw parser + supertest) so the raw
// body / signature / controller plumbing is genuinely exercised.

const ROOT = resolve(__dirname, '../../../..');
const SECRET = 'integration-indeed-apply-secret';
const TENANT_ID = '11111111-1111-7111-8111-1111111111aa';
const HOST = 'acme.aramo.ai';

// Apply EVERY migration in each needed schema's dir (sorted) — robust against the
// regenerated-client-selects-a-new-column ripple that a hand-curated list drifts
// into (a Postgres 500 when a newer migration is omitted).
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
];

// $$-aware DDL splitter (mirrors the canonicalization harness) — strips line
// comments, then splits on `;` outside `$$…$$` trigger bodies.
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

function applyPayload(id: string): {
  raw: Buffer;
  rawString: string;
  email: string;
  phone: string;
} {
  const email = 'ADA@Example.com';
  const phone = '+1 (415) 555-0100';
  // Send the STRING on the wire (superagent forwards a string verbatim; a Buffer
  // under application/json gets JSON-serialized, which would change the signed
  // bytes). The signature is computed over exactly these bytes.
  const rawString = JSON.stringify({
    id,
    applicant: { fullName: 'Ada Lovelace', email, phoneNumber: phone },
  });
  return { raw: Buffer.from(rawString, 'utf8'), rawString, email, phone };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SRC-1 PR-2 — Indeed Apply webhook spine (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let moduleRef: TestingModule;
    let app: INestApplication;
    let db: Client;
    let canonicalization: CanonicalizationService;
    const savedEnv: Record<string, string | undefined> = {};

    // Fake object storage: computes the SAME server-side sha256 (so acceptPayload
    // dedup is real), captures the stored bytes, returns a deterministic ref.
    const stored: { key: string; body: Buffer }[] = [];
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
        const key = `${input.tenant_id}/ingestion/${input.channel.toLowerCase()}/${input.external_source_id}/${stored.length}.json`;
        stored.push({ key, body: input.body });
        return { storage_ref: `s3://fake-bucket/${key}`, sha256 };
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
      process.env['ARAMO_IDENTITY_PEPPER'] = 'indeed-apply-integration-pepper';
      process.env['ARAMO_IDENTITY_ADMISSION_POLICY'] = 'PORTABLE_ONLY';
      process.env['APP_ROOT_DOMAIN'] = 'aramo.ai';
      process.env[INDEED_APPLY_WEBHOOK_SECRET_ENV] = SECRET;

      moduleRef = await Test.createTestingModule({
        imports: [IngestionModule, SourcedTalentModule, CanonicalizationModule],
        controllers: [IndeedApplyController],
        providers: [
          IndeedApplyWebhookService,
          { provide: ObjectStorageService, useValue: fakeStorage },
          { provide: TenantService, useValue: fakeTenants },
        ],
      }).compile();

      // Replicate main.ts route-scoped raw parser so the HTTP path is real.
      app = moduleRef.createNestApplication({ bodyParser: false });
      const http = app.getHttpAdapter().getInstance() as ReturnType<
        typeof express
      >;
      http.use(
        INDEED_APPLY_WEBHOOK_ROUTE,
        express.raw({ type: () => true, limit: INDEED_APPLY_MAX_BODY_BYTES }),
      );
      http.use(express.json());
      await app.init();

      canonicalization = moduleRef.get(CanonicalizationService);

      db = new Client({ connectionString: url });
      await db.connect();
    }, 180_000);

    afterAll(async () => {
      // app.close() drains CanonicalizationModule's BullMQ worker; the explicit
      // 60s hook timeout overrides vitest's 10s global so a slow graceful
      // shutdown does not red the suite (the Stage-A teardown precedent).
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    const rawCount = async (): Promise<number> => {
      const r = await db.query(
        `SELECT COUNT(*)::int AS c FROM "ingestion"."RawPayloadReference" WHERE tenant_id = $1`,
        [TENANT_ID],
      );
      return r.rows[0].c;
    };
    const arrivalCount = async (): Promise<number> => {
      const r = await db.query(
        `SELECT COUNT(*)::int AS c FROM "sourced_talent"."SourcedTalent" WHERE tenant_id = $1`,
        [TENANT_ID],
      );
      return r.rows[0].c;
    };

    it('valid signature → storage + RawPayloadReference + sourced_talent staging row (normalized + linkage), then canonicalize mints the SOURCED_TALENT ref', async () => {
      const applyId = 'apply-spine-001';
      const { raw, rawString, email, phone } = applyPayload(applyId);
      const sig = computeIndeedSignature(raw, SECRET);

      const res = await request(app.getHttpServer())
        .post(INDEED_APPLY_WEBHOOK_ROUTE)
        .set('Content-Type', 'application/json')
        .set('Host', HOST)
        .set('X-Indeed-Signature', sig)
        .send(rawString);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });

      // sourced_talent staging row: normalized contact (R8) + provenance linkage.
      const arrival = await db.query(
        `SELECT external_source_id, normalized_email, normalized_phone, provenance, legal_basis
           FROM "sourced_talent"."SourcedTalent"
          WHERE tenant_id = $1 AND source_channel = 'INDEED' AND external_source_id = $2`,
        [TENANT_ID, applyId],
      );
      expect(arrival.rows.length).toBe(1);
      expect(arrival.rows[0].normalized_email).toBe(normalizeEmail(email));
      expect(arrival.rows[0].normalized_phone).toBe(normalizePhone(phone));
      expect(arrival.rows[0].legal_basis).toEqual({
        basis: 'first_party_application',
        jurisdiction_note: 'PENDING_COUNSEL_A4',
      });

      // RawPayloadReference from the front door; provenance links to its id.
      const payload = await db.query(
        `SELECT id, source, storage_ref FROM "ingestion"."RawPayloadReference"
          WHERE tenant_id = $1 AND source = 'indeed'`,
        [TENANT_ID],
      );
      expect(payload.rows.length).toBe(1);
      const payloadId = payload.rows[0].id as string;
      expect(arrival.rows[0].provenance.ingestion_payload_id).toBe(payloadId);
      expect(arrival.rows[0].provenance.signature_header).toBe('x-indeed-signature');

      // Canonicalize the document arrival → a SOURCED_TALENT ResolutionSubjectRef
      // pointing at the RawPayloadReference.id (the two-surface layering, R1/R2).
      await canonicalization.canonicalize({
        payload_id: payloadId,
        source_channel: 'indeed',
        authContext: { tenant_id: TENANT_ID },
        requestId: 'canon-req-1',
      });
      const ref = await db.query(
        `SELECT subject_id FROM "talent_trust"."ResolutionSubjectRef"
          WHERE tenant_id = $1 AND ref_type = 'SOURCED_TALENT' AND ref_id = $2`,
        [TENANT_ID, payloadId],
      );
      expect(ref.rows.length).toBe(1);
    });

    it('re-application (same apply_id) is idempotent — original arrival row, no duplicate payload', async () => {
      const applyId = 'apply-spine-idem';
      const { raw, rawString } = applyPayload(applyId);
      const sig = computeIndeedSignature(raw, SECRET);
      const post = () =>
        request(app.getHttpServer())
          .post(INDEED_APPLY_WEBHOOK_ROUTE)
          .set('Content-Type', 'application/json')
          .set('Host', HOST)
          .set('X-Indeed-Signature', sig)
          .send(rawString);

      const first = await post();
      expect(first.status).toBe(200);
      const afterFirstArrivals = await arrivalCount();
      const afterFirstRaw = await rawCount();

      const second = await post();
      expect(second.status).toBe(200);

      // recordArrival idempotent on (tenant, INDEED, apply_id); acceptPayload
      // sha256-dedups the identical body → no new rows.
      expect(await arrivalCount()).toBe(afterFirstArrivals);
      expect(await rawCount()).toBe(afterFirstRaw);
    });

    it('invalid signature → 401 and ZERO rows written (no storage, no payload, no arrival)', async () => {
      const before = { raw: await rawCount(), arr: await arrivalCount() };
      const { raw, rawString } = applyPayload('apply-should-not-persist');

      const res = await request(app.getHttpServer())
        .post(INDEED_APPLY_WEBHOOK_ROUTE)
        .set('Content-Type', 'application/json')
        .set('Host', HOST)
        .set('X-Indeed-Signature', 'wrong-signature')
        .send(rawString);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({});

      expect(await rawCount()).toBe(before.raw);
      expect(await arrivalCount()).toBe(before.arr);
    });
  },
);
