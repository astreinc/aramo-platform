import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';

import { AppModule } from '../app.module.js';

// PR-A4 Gate 5 — ATS Batch 3 (talent-record + attachment) integration spec.
//
// Proof matrix:
//   A) A2-style three-axis gating proofs (entitlement / authz / site /
//      recruiter-delete divergence) applied to /v1/talent-records — the
//      pattern reuse verification.
//   B) Attachment owner-validation proof (directive §4 ruling — the
//      typed-discriminator integrity that exceeds OpenCATS's untyped
//      no-constraint blob table):
//        - attach to a real in-tenant TalentRecord → 201 succeeds.
//        - attach with a non-existent owner_id → 404 rejected.
//        - attach with a cross-tenant owner_id → 404 rejected.
//        - attach with owner_type other than `talent` → 422 (defined but
//          not wired at A4 — typed discriminator integrity is the design).
//   C) R10 structural check — assert the TalentRecordView shape carries
//      NO ranking / tier / score / reasoning field. Structural at the
//      response level (not just a schema review).
//
// Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
const TALENT_RECORD_INIT = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
);
const ATTACHMENT_INIT = resolve(
  ROOT,
  'libs/attachment/prisma/migrations/20260602120000_init_attachment_model/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-ats-batch3-talent-record-attachment-spec';
const ALG = 'RS256';

const TENANT_ATS = '01900000-0000-7000-8000-000000000001';
const TENANT_OTHER = '55555555-5555-7555-8555-555555555555';
const TENANT_NOT_ATS = '22222222-2222-7222-8222-222222222222';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';
const SITE_B = '44444444-4444-7444-8444-4444444444bb';

const RECRUITER = '00000000-0000-7000-8000-000000000bb1';
const TENANT_ADMIN = '00000000-0000-7000-8000-000000000aa1';

const RECRUITER_SCOPES = [
  'talent:read',
  'talent:create',
  'talent:edit',
];
const TENANT_ADMIN_SCOPES = [
  ...RECRUITER_SCOPES,
  'talent:delete',
];

// R10 forbidden tokens — any of these as a top-level key on the talent
// record DTO would be a refusal violation.
const R10_FORBIDDEN_KEYS = [
  'rank',
  'tier',
  'score',
  'reasoning',
  'match_class',
  'match_score',
  'matching_score',
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-A4 ATS Batch 3 — talent-record + attachment proofs (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let setupClient: Client;

    let recruiterJwt_Ats_SiteA: string;
    let recruiterJwt_NotAts_SiteA: string;
    let recruiterJwt_Ats_WrongSite: string;
    let unscopedJwt_Ats_SiteA: string;
    let tenantAdminJwt_Ats_SiteA: string;
    let recruiterJwt_OtherTenant_SiteA: string;

    async function signJwt(
      privateKey: SignKey,
      args: { sub: string; tenant_id: string; site_id?: string; scopes: string[] },
    ): Promise<string> {
      const builder = new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: args.tenant_id,
        scopes: args.scopes,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h');
      return builder.sign(privateKey);
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new Client({ connectionString: url });
      await setupClient.connect();

      for (const p of [ENTITLEMENT_INIT, TALENT_RECORD_INIT, ATTACHMENT_INIT]) {
        await setupClient.query(readFileSync(p, 'utf8'));
      }

      // Entitle BOTH tenants to `ats` so cross-tenant owner-id validation
      // tests can pass JwtAuthGuard → EntitlementGuard → RolesGuard and
      // be rejected by the service-layer owner check (not the entitlement
      // gate, which would mask the real test).
      await setupClient.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'ats'), ($2::uuid, 'ats')
         ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT_ATS, TENANT_OTHER],
      );

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const privateKey: SignKey = kp.privateKey as SignKey;

      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      recruiterJwt_Ats_SiteA = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });
      recruiterJwt_NotAts_SiteA = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_NOT_ATS,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });
      recruiterJwt_Ats_WrongSite = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_B,
        scopes: RECRUITER_SCOPES,
      });
      unscopedJwt_Ats_SiteA = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: [],
      });
      tenantAdminJwt_Ats_SiteA = await signJwt(privateKey, {
        sub: TENANT_ADMIN,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: TENANT_ADMIN_SCOPES,
      });
      recruiterJwt_OtherTenant_SiteA = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_OTHER,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
      );
      await app.init();
      const server = await app.listen(0);
      const address = server.address() as AddressInfo;
      port = address.port;
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await setupClient?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    // -------------------------------------------------------------------------
    // A) A2 pattern reuse on talent-record — three-axis gating + recruiter-delete.
    // -------------------------------------------------------------------------

    it('A2-reuse / entitlement axis: tenant lacking ats → 403 TENANT_CAPABILITY_NOT_ENTITLED', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/talent-records?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterJwt_NotAts_SiteA}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('TENANT_CAPABILITY_NOT_ENTITLED');
    });

    it('A2-reuse / authorization axis: user without scope → 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/talent-records?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${unscopedJwt_Ats_SiteA}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('A2-reuse / site axis: token site != requested site → 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/talent-records?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterJwt_Ats_WrongSite}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('A2-reuse / recruiter-delete divergence: recruiter DELETE /v1/talent-records/:id → 403', async () => {
      const createRes = await fetch(`http://127.0.0.1:${port}/v1/talent-records?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt_Ats_SiteA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          first_name: 'Delete',
          last_name: 'Divergence',
          site_id: SITE_A,
        }),
      });
      const rec = (await createRes.json()) as { id: string };

      const res = await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${rec.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${recruiterJwt_Ats_SiteA}` },
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');

      const adminRes = await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${rec.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
      expect(adminRes.status).toBe(204);
    });

    // -------------------------------------------------------------------------
    // B) Attachment owner-validation proof (directive §4 ruling).
    // -------------------------------------------------------------------------

    it('Attachment owner validation: real in-tenant talent → 201; non-existent / cross-tenant → 404; non-talent owner_type → 422', async () => {
      // Seed a TalentRecord in TENANT_ATS.
      const tRes = await fetch(`http://127.0.0.1:${port}/v1/talent-records?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt_Ats_SiteA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          first_name: 'Owner',
          last_name: 'Subject',
          site_id: SITE_A,
        }),
      });
      const talent = (await tRes.json()) as { id: string };

      // 1. Attach to a real in-tenant TalentRecord → 201.
      const okRes = await fetch(
        `http://127.0.0.1:${port}/v1/attachments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            owner_type: 'talent',
            owner_id: talent.id,
            file_name: 'resume.pdf',
            mime: 'application/pdf',
            size_bytes: 1024,
            storage_key: 'tenants/01900000-.../resumes/r1.pdf',
            is_resume: true,
            site_id: SITE_A,
          }),
        },
      );
      expect(okRes.status).toBe(201);
      const okBody = (await okRes.json()) as { owner_type: string; owner_id: string };
      expect(okBody.owner_type).toBe('talent');
      expect(okBody.owner_id).toBe(talent.id);

      // 2. Attach with a non-existent owner_id → 404.
      const ghostId = '99999999-9999-7999-8999-999999999999';
      const ghostRes = await fetch(
        `http://127.0.0.1:${port}/v1/attachments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            owner_type: 'talent',
            owner_id: ghostId,
            file_name: 'r.pdf',
            mime: 'application/pdf',
            size_bytes: 1,
            storage_key: 'tenants/.../r.pdf',
            site_id: SITE_A,
          }),
        },
      );
      expect(ghostRes.status).toBe(404);
      const ghostBody = (await ghostRes.json()) as { error: { code: string } };
      expect(ghostBody.error?.code).toBe('NOT_FOUND');

      // 3. Attach with a cross-tenant owner_id (talent exists in TENANT_ATS;
      //    the request comes from TENANT_OTHER) → 404 (the validateOwner
      //    findById is tenant-scoped — the row is invisible across tenants).
      const crossRes = await fetch(
        `http://127.0.0.1:${port}/v1/attachments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt_OtherTenant_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            owner_type: 'talent',
            owner_id: talent.id, // talent lives in TENANT_ATS, NOT TENANT_OTHER
            file_name: 'r.pdf',
            mime: 'application/pdf',
            size_bytes: 1,
            storage_key: 'tenants/.../r.pdf',
            site_id: SITE_A,
          }),
        },
      );
      expect(crossRes.status).toBe(404);
      const crossBody = (await crossRes.json()) as { error: { code: string } };
      expect(crossBody.error?.code).toBe('NOT_FOUND');

      // 4. Attach with owner_type other than `talent` (defined in the enum
      //    but not wired at A4) → 422 VALIDATION_ERROR.
      const unwiredRes = await fetch(
        `http://127.0.0.1:${port}/v1/attachments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            owner_type: 'company', // defined in enum, not wired at A4
            owner_id: talent.id,
            file_name: 'r.pdf',
            mime: 'application/pdf',
            size_bytes: 1,
            storage_key: 'tenants/.../r.pdf',
            site_id: SITE_A,
          }),
        },
      );
      expect(unwiredRes.status).toBe(422);
      const unwiredBody = (await unwiredRes.json()) as { error: { code: string } };
      expect(unwiredBody.error?.code).toBe('VALIDATION_ERROR');
    });

    it('Attachment list-for-owner: returns attachments scoped to (owner_type, owner_id) in tenant', async () => {
      // Seed two talent records and an attachment on each.
      const tA = await fetch(`http://127.0.0.1:${port}/v1/talent-records?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt_Ats_SiteA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ first_name: 'A', last_name: 'One', site_id: SITE_A }),
      });
      const tAJson = (await tA.json()) as { id: string };
      const tB = await fetch(`http://127.0.0.1:${port}/v1/talent-records?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt_Ats_SiteA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ first_name: 'B', last_name: 'Two', site_id: SITE_A }),
      });
      const tBJson = (await tB.json()) as { id: string };

      for (const id of [tAJson.id, tBJson.id]) {
        const r = await fetch(`http://127.0.0.1:${port}/v1/attachments?site_id=${SITE_A}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt_Ats_SiteA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            owner_type: 'talent',
            owner_id: id,
            file_name: 'doc.pdf',
            mime: 'application/pdf',
            size_bytes: 100,
            storage_key: `tenants/.../${id}.pdf`,
            site_id: SITE_A,
          }),
        });
        expect(r.status).toBe(201);
      }

      // List attachments for talent A → returns exactly its own.
      const listA = await fetch(
        `http://127.0.0.1:${port}/v1/attachments?owner_type=talent&owner_id=${tAJson.id}&site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterJwt_Ats_SiteA}` },
        },
      );
      expect(listA.status).toBe(200);
      const listABody = (await listA.json()) as { items: Array<{ owner_id: string }> };
      expect(listABody.items.every((i) => i.owner_id === tAJson.id)).toBe(true);
      expect(listABody.items.length).toBeGreaterThan(0);
    });

    // -------------------------------------------------------------------------
    // C) R10 structural — TalentRecordView must carry NO ranking field.
    // -------------------------------------------------------------------------

    it('R10: TalentRecordView response carries NO rank/tier/score/reasoning fields', async () => {
      const createRes = await fetch(`http://127.0.0.1:${port}/v1/talent-records?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt_Ats_SiteA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          first_name: 'R10',
          last_name: 'Check',
          site_id: SITE_A,
        }),
      });
      expect(createRes.status).toBe(201);
      const rec = (await createRes.json()) as Record<string, unknown>;
      const keys = Object.keys(rec);

      for (const forbidden of R10_FORBIDDEN_KEYS) {
        // Top-level key check.
        expect(keys, `R10 violation: top-level key '${forbidden}' present in TalentRecordView`).not.toContain(
          forbidden,
        );
        // Substring guard (catches e.g. 'match_score', 'rank_class').
        for (const k of keys) {
          expect(
            k.toLowerCase().includes(forbidden.toLowerCase()),
            `R10 violation: key '${k}' contains forbidden substring '${forbidden}'`,
          ).toBe(false);
        }
      }
    });
  },
);
