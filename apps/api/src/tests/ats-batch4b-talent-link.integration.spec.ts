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
import { TalentRepository } from '@aramo/talent';

import { AppModule } from '../app.module.js';

// PR-A5b-2 Gate 5 — ATS Batch 4b (TalentRecord ↔ Core-Talent link)
// integration spec. THE keystone of the ATS↔Core seam.
//
// === The five load-bearing proofs (the sacred boundaries) ===
//
//   (1) LINK (associate-a-real-given-id): seed a Core Talent + its
//       overlay for the tenant; link a TalentRecord to it → the ref
//       persists; the read returns the association.
//   (2) LINK-NOT-CREATE (the sacred boundary, bit-identical row-counts):
//       pre/post link, `talent."Talent"` and `talent."TalentTenantOverlay"`
//       row counts are bit-identical. The linker created NO Core
//       identity — it only set the ATS-side ref. Same proof for
//       unlink.
//   (3) REJECT bad/cross-tenant id (the in-tenant gate):
//       (a) link to a non-existent core_talent_id → 422
//           TALENT_LINK_INVALID, reason='core_talent_not_found'.
//       (b) link to a Core Talent that exists but has NO overlay for
//           the requesting tenant → 422 TALENT_LINK_INVALID,
//           reason='tenant_overlay_missing'.
//       (c) link to a Core Talent whose overlay is in a DIFFERENT
//           tenant → same 422 reason='tenant_overlay_missing'
//           (cross-tenant isolation: the overlay lookup is keyed on
//           (talent_id, request.tenant_id) so a foreign overlay is
//           invisible).
//   (4) NULLABLE / UNLINK: an unlinked TalentRecord is valid (GET
//       /link returns {core_talent_id: null}); unlink sets the ref
//       back to null; idempotent (unlink twice = same result).
//   (5) NO-RESOLUTION (the structural boundary): the linker takes
//       core_talent_id as an EXPLICIT input parameter. The structural
//       guarantee — TalentRepository has NO `findTalentByEmail` /
//       `resolveIdentity` / `matchIdentity` surface — is asserted at
//       runtime by enumerating the repository's method set.
//
// Plus the A2 three-axis gating proofs on /v1/talent-records/:id/link.
//
// Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
const TALENT_INIT = resolve(
  ROOT,
  'libs/talent/prisma/migrations/20260516085014_init_talent_model/migration.sql',
);
const TALENT_RECORD_INIT = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
);
// PR-A5b-2 — additive Core-Talent link column.
const TALENT_RECORD_LINK_ADD = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260603020000_add_core_talent_link_to_talent_record/migration.sql',
);
// PR-A8-1 — additive back-reference column on TalentRecord. The
// Prisma client's RETURNING projection includes import_batch_id;
// absent in DB → 500 INTERNAL_ERROR on POST create.
const TALENT_RECORD_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260603140100_add_import_batch_id_to_talent_record/migration.sql',
);
// Segment 2 — the talent-stated availability_status + engagement_type columns
// (Prisma create RETURNING projects them; the test DB must carry them).
const TALENT_RECORD_STATED_FIELDS = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260615000000_talent_stated_fields/migration.sql',
);
// 4d — the overlay-fold columns + cluster_id (TalentRecord RETURNING projects
// them; the test DB must carry them or createTalentRecord 500s).
const TALENT_RECORD_OVERLAY_FOLD = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260630140000_overlay_fold_cluster_id/migration.sql',
);
// 4d — identity_index (PersonCluster) for the cluster-exists link validation.
const IDENTITY_INDEX_INIT = resolve(
  ROOT,
  'libs/identity-index/prisma/migrations/20260630000000_init_identity_index/migration.sql',
);

const MIGRATIONS = [
  ENTITLEMENT_INIT,
  TALENT_INIT,
  TALENT_RECORD_INIT,
  TALENT_RECORD_LINK_ADD,
  TALENT_RECORD_IMPORT_BACK_REF,
  TALENT_RECORD_STATED_FIELDS,
  TALENT_RECORD_OVERLAY_FOLD,
  IDENTITY_INDEX_INIT,
];

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-ats-batch4b-talent-link-spec';
const ALG = 'RS256';

const TENANT_ATS = '01900000-0000-7000-8000-000000000001';
const TENANT_OTHER = '55555555-5555-7555-8555-555555555555';
const TENANT_NOT_ATS = '22222222-2222-7222-8222-222222222222';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';
const SITE_B = '44444444-4444-7444-8444-4444444444bb';

const RECRUITER = '00000000-0000-7000-8000-000000000bb1';
const TENANT_ADMIN = '00000000-0000-7000-8000-000000000aa1';

// PR-A5b-2 reuses `talent:read` (GET /link) and `talent:edit`
// (POST/DELETE /link) — no new scope.
const RECRUITER_SCOPES = [
  'talent:read',
  'talent:create',
  'talent:edit',
];

// Core Talent ids seeded in beforeAll.
const TALENT_LINKED_OK = 'aa1aa1aa-1aaa-7aaa-8aaa-aaaaaaaaaa01';
const TALENT_OTHER_TENANT_ONLY = 'aa1aa1aa-1aaa-7aaa-8aaa-aaaaaaaaaa02';
const TALENT_NO_OVERLAY = 'aa1aa1aa-1aaa-7aaa-8aaa-aaaaaaaaaa03';
const TALENT_REPLACEMENT = 'aa1aa1aa-1aaa-7aaa-8aaa-aaaaaaaaaa04';
const TALENT_DOES_NOT_EXIST = 'aa1aa1aa-1aaa-7aaa-8aaa-aaaaaaaaaa99';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-A5b-2 ATS Batch 4b — TalentRecord↔Core-Talent link (the keystone)',
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

    async function countTalentRows(): Promise<number> {
      const r = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM talent."Talent"`,
      );
      return Number(r.rows[0]!.c);
    }

    async function countOverlayRows(): Promise<number> {
      const r = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM talent."TalentTenantOverlay"`,
      );
      return Number(r.rows[0]!.c);
    }

    async function readCoreTalentId(
      talentRecordId: string,
    ): Promise<string | null> {
      const r = await setupClient.query<{ core_talent_id: string | null }>(
        `SELECT core_talent_id FROM talent_record."TalentRecord"
         WHERE id = $1::uuid`,
        [talentRecordId],
      );
      return r.rows[0]?.core_talent_id ?? null;
    }

    // 4d — read the new cluster_id pointer; seed a PERSON_CLUSTER.
    async function readClusterId(
      talentRecordId: string,
    ): Promise<string | null> {
      const r = await setupClient.query<{ cluster_id: string | null }>(
        `SELECT cluster_id FROM talent_record."TalentRecord" WHERE id = $1::uuid`,
        [talentRecordId],
      );
      return r.rows[0]?.cluster_id ?? null;
    }
    async function seedCluster(id: string): Promise<void> {
      await setupClient.query(
        `INSERT INTO identity_index."PersonCluster" (id, updated_at)
         VALUES ($1::uuid, NOW()) ON CONFLICT (id) DO NOTHING`,
        [id],
      );
    }

    async function createTalentRecord(
      jwt: string,
      args?: { tenant_id_for_url?: string; first?: string },
    ): Promise<{ id: string }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/talent-records?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            first_name: args?.first ?? 'Pat',
            last_name: 'Linktest',
            site_id: SITE_A,
          }),
        },
      );
      const body = (await res.json()) as { id: string };
      return body;
    }

    async function postLink(
      jwt: string,
      talentRecordId: string,
      coreTalentId: string,
      clusterId?: string,
    ): Promise<{ status: number; body: unknown }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${talentRecordId}/link?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            clusterId === undefined
              ? { core_talent_id: coreTalentId }
              : { core_talent_id: coreTalentId, cluster_id: clusterId },
          ),
        },
      );
      return { status: res.status, body: await res.json() };
    }

    async function getLink(
      jwt: string,
      talentRecordId: string,
    ): Promise<{ status: number; body: unknown }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${talentRecordId}/link?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${jwt}` },
        },
      );
      return { status: res.status, body: await res.json() };
    }

    async function deleteLink(
      jwt: string,
      talentRecordId: string,
    ): Promise<{ status: number; body: unknown }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${talentRecordId}/link?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${jwt}` },
        },
      );
      return { status: res.status, body: await res.json() };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new Client({ connectionString: url });
      await setupClient.connect();

      for (const p of MIGRATIONS) {
        await setupClient.query(readFileSync(p, 'utf8'));
      }

      // Entitle TENANT_ATS + TENANT_OTHER to `ats` so the cross-tenant
      // assertions pass JwtAuthGuard → EntitlementGuard → RolesGuard
      // and are rejected by the linker's in-tenant gate (not the
      // entitlement layer, which would mask the real test).
      await setupClient.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'ats'), ($2::uuid, 'ats')
         ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT_ATS, TENANT_OTHER],
      );

      // Seed Core Talent rows + overlays. Four Talents:
      //   - TALENT_LINKED_OK         — overlay in TENANT_ATS (the happy path).
      //   - TALENT_OTHER_TENANT_ONLY — overlay in TENANT_OTHER only (the
      //     cross-tenant rejection target).
      //   - TALENT_NO_OVERLAY        — no overlay (identity exists, but
      //     this tenant has no relationship → reason='tenant_overlay_missing').
      //   - TALENT_REPLACEMENT       — overlay in TENANT_ATS, used to test
      //     the refuse-re-link-to-different-id branch.
      for (const id of [
        TALENT_LINKED_OK,
        TALENT_OTHER_TENANT_ONLY,
        TALENT_NO_OVERLAY,
        TALENT_REPLACEMENT,
      ]) {
        await setupClient.query(
          `INSERT INTO talent."Talent" (id, lifecycle_status, created_at, updated_at)
           VALUES ($1::uuid, 'active', NOW(), NOW())
           ON CONFLICT (id) DO NOTHING`,
          [id],
        );
      }
      // TENANT_ATS overlays.
      for (const tid of [TALENT_LINKED_OK, TALENT_REPLACEMENT]) {
        await setupClient.query(
          `INSERT INTO talent."TalentTenantOverlay"
           (id, talent_id, tenant_id, source_channel, tenant_status, created_at, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'recruiter_capture', 'active', NOW(), NOW())
           ON CONFLICT (talent_id, tenant_id) DO NOTHING`,
          [tid, TENANT_ATS],
        );
      }
      // TENANT_OTHER overlay (for the cross-tenant test).
      await setupClient.query(
        `INSERT INTO talent."TalentTenantOverlay"
         (id, talent_id, tenant_id, source_channel, tenant_status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'recruiter_capture', 'active', NOW(), NOW())
         ON CONFLICT (talent_id, tenant_id) DO NOTHING`,
        [TALENT_OTHER_TENANT_ONLY, TENANT_OTHER],
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
        scopes: [...RECRUITER_SCOPES, 'talent:delete'],
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
    // A) A2 three-axis gating — entitlement / authorization / site axis on
    //    the new /link routes (the pattern-reuse verification).
    // -------------------------------------------------------------------------

    it('A2-reuse / entitlement axis: tenant lacking ats → 403 TENANT_CAPABILITY_NOT_ENTITLED', async () => {
      // No record needed — guard fires before the controller runs. We
      // hit the route with a random UUID.
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${TALENT_LINKED_OK}/link?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterJwt_NotAts_SiteA}` },
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('TENANT_CAPABILITY_NOT_ENTITLED');
    });

    it('A2-reuse / authorization axis: user without talent:read scope → 403 INSUFFICIENT_PERMISSIONS on GET /link', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${TALENT_LINKED_OK}/link?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${unscopedJwt_Ats_SiteA}` },
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('A2-reuse / site axis: token site != requested site → 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${TALENT_LINKED_OK}/link?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterJwt_Ats_WrongSite}` },
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    // -------------------------------------------------------------------------
    // B) Proof (1) — LINK (the happy path).
    // -------------------------------------------------------------------------

    it('Link (happy path): GET returns null pre-link; POST /link succeeds; GET returns the association', async () => {
      const record = await createTalentRecord(recruiterJwt_Ats_SiteA);

      // Pre-link: GET returns null.
      const pre = await getLink(recruiterJwt_Ats_SiteA, record.id);
      expect(pre.status).toBe(200);
      expect(pre.body).toEqual({
        talent_record_id: record.id,
        core_talent_id: null,
      });

      // POST /link succeeds (Talent + overlay both present for TENANT_ATS).
      const link = await postLink(
        recruiterJwt_Ats_SiteA,
        record.id,
        TALENT_LINKED_OK,
      );
      expect(link.status).toBe(200);
      expect(link.body).toEqual({
        talent_record_id: record.id,
        core_talent_id: TALENT_LINKED_OK,
      });

      // GET returns the association.
      const post = await getLink(recruiterJwt_Ats_SiteA, record.id);
      expect(post.status).toBe(200);
      expect(post.body).toEqual({
        talent_record_id: record.id,
        core_talent_id: TALENT_LINKED_OK,
      });

      // Persisted at the DB level.
      expect(await readCoreTalentId(record.id)).toBe(TALENT_LINKED_OK);

      // Cleanup (unlink, then delete the record via tenant-admin).
      await deleteLink(recruiterJwt_Ats_SiteA, record.id);
      await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${record.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    // -------------------------------------------------------------------------
    // C) Proof (2) — LINK-NOT-CREATE (the sacred boundary). Bit-identical
    //    talent.Talent + talent.TalentTenantOverlay row-counts pre/post any
    //    link / unlink operation.
    // -------------------------------------------------------------------------

    it('LINK-NOT-CREATE: link / unlink leave talent.Talent and talent.TalentTenantOverlay row-counts bit-identical', async () => {
      const talentRowsBefore = await countTalentRows();
      const overlayRowsBefore = await countOverlayRows();

      const record = await createTalentRecord(recruiterJwt_Ats_SiteA, {
        first: 'BoundaryCheck',
      });

      // Link.
      const link = await postLink(
        recruiterJwt_Ats_SiteA,
        record.id,
        TALENT_LINKED_OK,
      );
      expect(link.status).toBe(200);
      // The keystone boundary: no Core row was created or mutated.
      expect(await countTalentRows()).toBe(talentRowsBefore);
      expect(await countOverlayRows()).toBe(overlayRowsBefore);

      // Unlink.
      const unlink = await deleteLink(recruiterJwt_Ats_SiteA, record.id);
      expect(unlink.status).toBe(200);
      expect(await countTalentRows()).toBe(talentRowsBefore);
      expect(await countOverlayRows()).toBe(overlayRowsBefore);

      await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${record.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    // -------------------------------------------------------------------------
    // D) Proof (3) — REJECT bad/cross-tenant. The in-tenant gate.
    // -------------------------------------------------------------------------

    it('Reject non-existent core_talent_id: 422 TALENT_LINK_INVALID, reason=core_talent_not_found', async () => {
      const record = await createTalentRecord(recruiterJwt_Ats_SiteA);
      const link = await postLink(
        recruiterJwt_Ats_SiteA,
        record.id,
        TALENT_DOES_NOT_EXIST,
      );
      expect(link.status).toBe(422);
      const body = link.body as {
        error: { code: string; details?: { reason?: string } };
      };
      expect(body.error.code).toBe('TALENT_LINK_INVALID');
      expect(body.error.details?.reason).toBe('core_talent_not_found');

      // Link column unchanged.
      expect(await readCoreTalentId(record.id)).toBeNull();

      await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${record.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    it('4d: link SUCCEEDS when the Talent exists but has no overlay (guard-5 collapsed — the in-tenant gate is the TalentRecord, not the overlay)', async () => {
      const record = await createTalentRecord(recruiterJwt_Ats_SiteA);
      const link = await postLink(
        recruiterJwt_Ats_SiteA,
        record.id,
        TALENT_NO_OVERLAY,
      );
      // Pre-4d this was 422 tenant_overlay_missing; 4d removed the overlay gate.
      expect(link.status).toBe(200);
      expect(await readCoreTalentId(record.id)).toBe(TALENT_NO_OVERLAY);

      await deleteLink(recruiterJwt_Ats_SiteA, record.id);
      await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${record.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    it('4d: cross-tenant isolation is now the TalentRecord-in-tenant gate (guard-1), not the overlay — both tenants can link the same (global) Core Talent against their OWN record', async () => {
      // Pre-4d, TENANT_ATS linking a Talent whose overlay is only in
      // TENANT_OTHER was rejected (tenant_overlay_missing). 4d collapsed that
      // gate: Core Talent is a global husk, guard-4 finds it, and the in-tenant
      // protection is that the TalentRecord being linked is in the caller's
      // tenant (guard-1 — covered by the 404-on-other-tenant-record test). So
      // linking now SUCCEEDS against the caller's own record.
      const record = await createTalentRecord(recruiterJwt_Ats_SiteA);
      const link = await postLink(
        recruiterJwt_Ats_SiteA,
        record.id,
        TALENT_OTHER_TENANT_ONLY,
      );
      expect(link.status).toBe(200);
      expect(await readCoreTalentId(record.id)).toBe(TALENT_OTHER_TENANT_ONLY);
      await deleteLink(recruiterJwt_Ats_SiteA, record.id);
      await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${record.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );

      // Symmetric proof from the other side: TENANT_OTHER links its OWN record
      // to the same global Core Talent and succeeds.
      const otherRecord = await createTalentRecord(
        recruiterJwt_OtherTenant_SiteA,
      );
      const otherLink = await postLink(
        recruiterJwt_OtherTenant_SiteA,
        otherRecord.id,
        TALENT_OTHER_TENANT_ONLY,
      );
      expect(otherLink.status).toBe(200);

      // Cleanup.
      await deleteLink(recruiterJwt_OtherTenant_SiteA, otherRecord.id);
      await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${otherRecord.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: {
            // No tenant_admin JWT for TENANT_OTHER seeded — use the
            // recruiter's record-edit scope to delete via repository
            // path. Actually `talent:delete` is tenant_admin only. We
            // can't clean OtherTenant's row in this spec; tolerate the
            // dangling row (the test runs in a fresh container each
            // run).
            Authorization: `Bearer ${recruiterJwt_OtherTenant_SiteA}`,
          },
        },
      );
      await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${record.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    // -------------------------------------------------------------------------
    // D2) 4d — cluster_id pointer + cluster-exists validation.
    // -------------------------------------------------------------------------

    it('4d: link with a valid cluster_id writes TalentRecord.cluster_id (cluster-exists validated against identity_index)', async () => {
      const CLUSTER_OK = 'c1c1c1c1-1c1c-7c1c-8c1c-c1c1c1c1c1c1';
      await seedCluster(CLUSTER_OK);
      const record = await createTalentRecord(recruiterJwt_Ats_SiteA);
      const link = await postLink(
        recruiterJwt_Ats_SiteA,
        record.id,
        TALENT_NO_OVERLAY,
        CLUSTER_OK,
      );
      expect(link.status).toBe(200);
      expect(await readClusterId(record.id)).toBe(CLUSTER_OK);
      // core_talent_id is written alongside, UNTOUCHED by 4d's semantics.
      expect(await readCoreTalentId(record.id)).toBe(TALENT_NO_OVERLAY);

      await deleteLink(recruiterJwt_Ats_SiteA, record.id);
      await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${record.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    it('4d: link with a non-existent cluster_id → 422 TALENT_LINK_INVALID, reason=cluster_not_found', async () => {
      const record = await createTalentRecord(recruiterJwt_Ats_SiteA);
      const link = await postLink(
        recruiterJwt_Ats_SiteA,
        record.id,
        TALENT_NO_OVERLAY,
        'deadbeef-dead-7ead-8ead-deaddeaddead',
      );
      expect(link.status).toBe(422);
      const body = link.body as {
        error: { code: string; details?: { reason?: string } };
      };
      expect(body.error.code).toBe('TALENT_LINK_INVALID');
      expect(body.error.details?.reason).toBe('cluster_not_found');
      // Refused → neither pointer written.
      expect(await readClusterId(record.id)).toBeNull();
      expect(await readCoreTalentId(record.id)).toBeNull();

      await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${record.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    // -------------------------------------------------------------------------
    // E) Proof (4) — NULLABLE / UNLINK / IDEMPOTENCY.
    // -------------------------------------------------------------------------

    it('Nullable: an unlinked TalentRecord is valid; GET /link returns null; double unlink is idempotent', async () => {
      const record = await createTalentRecord(recruiterJwt_Ats_SiteA);

      // Just-created: unlinked.
      const pre = await getLink(recruiterJwt_Ats_SiteA, record.id);
      expect((pre.body as { core_talent_id: string | null }).core_talent_id).toBeNull();

      // Unlink while already unlinked: idempotent.
      const u1 = await deleteLink(recruiterJwt_Ats_SiteA, record.id);
      expect(u1.status).toBe(200);
      expect((u1.body as { core_talent_id: string | null }).core_talent_id).toBeNull();
      const u2 = await deleteLink(recruiterJwt_Ats_SiteA, record.id);
      expect(u2.status).toBe(200);

      await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${record.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    it('Idempotent re-link to the same id: 200 no-op; re-link to a DIFFERENT id refused with reason=already_linked_to_different_id', async () => {
      const record = await createTalentRecord(recruiterJwt_Ats_SiteA);
      const first = await postLink(
        recruiterJwt_Ats_SiteA,
        record.id,
        TALENT_LINKED_OK,
      );
      expect(first.status).toBe(200);

      // Same id again → 200 no-op.
      const same = await postLink(
        recruiterJwt_Ats_SiteA,
        record.id,
        TALENT_LINKED_OK,
      );
      expect(same.status).toBe(200);
      expect((same.body as { core_talent_id: string }).core_talent_id).toBe(
        TALENT_LINKED_OK,
      );

      // Different id (with a valid overlay for this tenant): refused.
      // The recruiter must unlink first — defensive against identity
      // confusion.
      const diff = await postLink(
        recruiterJwt_Ats_SiteA,
        record.id,
        TALENT_REPLACEMENT,
      );
      expect(diff.status).toBe(422);
      const body = diff.body as {
        error: { code: string; details?: { reason?: string } };
      };
      expect(body.error.code).toBe('TALENT_LINK_INVALID');
      expect(body.error.details?.reason).toBe('already_linked_to_different_id');

      // Original link survives.
      expect(await readCoreTalentId(record.id)).toBe(TALENT_LINKED_OK);

      // Unlink then re-link to the REPLACEMENT — should succeed (the
      // unlink-first protocol).
      await deleteLink(recruiterJwt_Ats_SiteA, record.id);
      const relink = await postLink(
        recruiterJwt_Ats_SiteA,
        record.id,
        TALENT_REPLACEMENT,
      );
      expect(relink.status).toBe(200);
      expect(await readCoreTalentId(record.id)).toBe(TALENT_REPLACEMENT);

      // Cleanup.
      await deleteLink(recruiterJwt_Ats_SiteA, record.id);
      await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${record.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    // -------------------------------------------------------------------------
    // F) Proof (5) — NO-RESOLUTION boundary. Structural: TalentRepository
    //    carries no findTalentByEmail / resolveIdentity / matchIdentity
    //    surface. The linker can ONLY associate by id; it has no way to
    //    infer the right id from any other identifier.
    // -------------------------------------------------------------------------

    it('NO-RESOLUTION boundary: TalentRepository exposes no findTalentByEmail / resolveIdentity / matchIdentity surface', () => {
      // Inspect the prototype directly — this is a structural assertion
      // about the SHAPE of the only Core-Talent read surface the linker
      // can call. If anyone adds a resolution method, this test will
      // flag it; the test is the seam between A5b-2 (associate-only)
      // and a future Tier-3 identity resolver.
      const protoMethods = Object.getOwnPropertyNames(
        TalentRepository.prototype,
      ).filter((m) => m !== 'constructor');
      protoMethods.sort();

      // EXPECTED surface: createTalent, createOverlay, findOverlayByTenant,
      // findTalentById. NO resolution method anywhere.
      expect(protoMethods).toEqual([
        'createOverlay',
        'createTalent',
        'findOverlayByTenant',
        'findTalentById',
      ]);

      // The forbidden-name probes — if any of these EVER lands, A5b-2's
      // associate-not-resolve boundary is being violated. The
      // assertions are individually named so a future regression points
      // at the exact name.
      const forbidden = [
        'findTalentByEmail',
        'findByEmail',
        'resolveIdentity',
        'resolveTalent',
        'matchIdentity',
        'searchTalent',
      ];
      for (const name of forbidden) {
        expect(
          protoMethods.includes(name),
          `TalentRepository must NOT expose a resolution method named ${name} ` +
            `(A5b-2 keystone boundary: ASSOCIATE-NOT-RESOLVE)`,
        ).toBe(false);
      }
    });
  },
);
