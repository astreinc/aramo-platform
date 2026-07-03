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
import { IdentityIndexRepository } from '@aramo/identity-index';

import { AppModule } from '../app.module.js';

// ATS Batch 4b (TalentRecord ↔ PERSON_CLUSTER link) integration spec.
// THE keystone of the ATS↔identity seam.
//
// 4e-rest: the Core-Talent link (core_talent_id) was dropped once engagement
// (#349) + consent (#350) released their Core reads. The link is now
// CLUSTER-ONLY — the TalentRecord.cluster_id pointer into the PII-free
// identity_index (PersonCluster). The proofs below are the cluster-axis
// re-statement of the original Core-link keystone.
//
// === The load-bearing proofs (the sacred boundaries) ===
//
//   (1) LINK (associate-a-real-given-cluster): seed a PersonCluster; link a
//       TalentRecord to it → cluster_id persists; GET /link returns
//       is_linked=true.
//   (2) LINK-NOT-CREATE (the sacred boundary, bit-identical row-counts):
//       pre/post link, `identity_index."PersonCluster"` row-count is
//       bit-identical (the linker created NO cluster — it only set the
//       ATS-side pointer). The deferred Core husk (`talent."Talent"` /
//       `talent."TalentTenantOverlay"`) is likewise never touched. Same
//       proof for unlink.
//   (3) REJECT non-existent cluster (the cluster-exists gate, guard-4):
//       link to a cluster_id absent from identity_index → 422
//       TALENT_LINK_INVALID, reason='cluster_not_found'.
//   (4) NULLABLE / UNLINK: an unlinked TalentRecord is valid (GET /link
//       returns is_linked=false); unlink clears the pointer; idempotent
//       (unlink twice = same result). Re-link to the same cluster = 200
//       no-op; re-link to a DIFFERENT cluster = 422
//       reason='already_linked_to_different_id'.
//   (5) NO-PII-RESOLUTION (the structural boundary): the linker takes
//       cluster_id as an EXPLICIT input parameter and validates it via
//       IdentityIndexRepository.findClusterById. The structural guarantee —
//       identity_index carries NO PII-keyed resolution surface
//       (findClusterByEmail / resolveIdentity / matchIdentity) — is asserted
//       at runtime by enumerating the repository's method set. (Opaque
//       HMAC-fingerprint resolution EXISTS for the canonicalization resolver,
//       but it is PII-free by construction — the I14 wall — and the linker
//       never calls it.)
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
// The deferred Core husk tables — retained this increment (TR-2-coordinated
// drop). Applied so the LINK-NOT-CREATE proof can assert the linker never
// touches them.
const TALENT_INIT = resolve(
  ROOT,
  'libs/talent/prisma/migrations/20260516085014_init_talent_model/migration.sql',
);
const TALENT_RECORD_INIT = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
);
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
// Gate-1 G1-A — work_authorization column (regenerated client projects it).
const TALENT_RECORD_WORK_AUTH = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260702120000_add_work_authorization_to_talent_record/migration.sql',
);
// 4e-rest — drops core_talent_id (last, so the test schema matches the
// regenerated Prisma client, which no longer projects the column).
const TALENT_RECORD_DROP_CORE = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260701120000_drop_core_talent_id/migration.sql',
);
// identity_index (PersonCluster) for the cluster-exists link validation.
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
  TALENT_RECORD_WORK_AUTH,
  TALENT_RECORD_DROP_CORE,
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

// Reuses `talent:read` (GET /link) and `talent:edit` (POST/DELETE /link) —
// no new scope.
const RECRUITER_SCOPES = [
  'talent:read',
  'talent:create',
  'talent:edit',
];

// PERSON_CLUSTER ids seeded in beforeAll.
const CLUSTER_OK = 'c1c1c1c1-1c1c-7c1c-8c1c-c1c1c1c1c101';
const CLUSTER_REPLACEMENT = 'c1c1c1c1-1c1c-7c1c-8c1c-c1c1c1c1c104';
const CLUSTER_DOES_NOT_EXIST = 'c1c1c1c1-1c1c-7c1c-8c1c-c1c1c1c1c199';
// Any UUID for path-only A2 gating hits (the guard fires before the controller).
const ANY_RECORD_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddd01';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ATS Batch 4b — TalentRecord↔PERSON_CLUSTER link (the keystone, cluster-only)',
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

    // The deferred Core husk — the linker must never touch these.
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

    // The cluster index — the LINK-NOT-CREATE boundary the linker validates
    // against but must never mint into.
    async function countClusterRows(): Promise<number> {
      const r = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM identity_index."PersonCluster"`,
      );
      return Number(r.rows[0]!.c);
    }

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
      args?: { first?: string },
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
      clusterId: string,
    ): Promise<{ status: number; body: unknown }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${talentRecordId}/link?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ cluster_id: clusterId }),
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
      // assertions pass JwtAuthGuard → EntitlementGuard → RolesGuard.
      await setupClient.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'ats'), ($2::uuid, 'ats')
         ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT_ATS, TENANT_OTHER],
      );

      // Seed the PERSON_CLUSTERs the link path validates against.
      for (const id of [CLUSTER_OK, CLUSTER_REPLACEMENT]) {
        await seedCluster(id);
      }

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
    //    the /link routes (the pattern-reuse verification).
    // -------------------------------------------------------------------------

    it('A2-reuse / entitlement axis: tenant lacking ats → 403 TENANT_CAPABILITY_NOT_ENTITLED', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${ANY_RECORD_ID}/link?site_id=${SITE_A}`,
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
        `http://127.0.0.1:${port}/v1/talent-records/${ANY_RECORD_ID}/link?site_id=${SITE_A}`,
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
        `http://127.0.0.1:${port}/v1/talent-records/${ANY_RECORD_ID}/link?site_id=${SITE_A}`,
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

    it('Link (happy path): GET is_linked=false pre-link; POST /link succeeds; GET is_linked=true; cluster_id persisted', async () => {
      const record = await createTalentRecord(recruiterJwt_Ats_SiteA);

      // Pre-link: GET returns is_linked=false.
      const pre = await getLink(recruiterJwt_Ats_SiteA, record.id);
      expect(pre.status).toBe(200);
      expect(pre.body).toEqual({
        talent_record_id: record.id,
        is_linked: false,
      });

      // POST /link succeeds (cluster exists in identity_index).
      const link = await postLink(recruiterJwt_Ats_SiteA, record.id, CLUSTER_OK);
      expect(link.status).toBe(200);
      expect(link.body).toEqual({
        talent_record_id: record.id,
        is_linked: true,
      });

      // GET reflects the link.
      const post = await getLink(recruiterJwt_Ats_SiteA, record.id);
      expect(post.status).toBe(200);
      expect(post.body).toEqual({
        talent_record_id: record.id,
        is_linked: true,
      });

      // Persisted at the DB level (server-only pointer).
      expect(await readClusterId(record.id)).toBe(CLUSTER_OK);

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
    //    identity_index.PersonCluster row-count pre/post any link/unlink; the
    //    deferred Core husk is likewise never touched.
    // -------------------------------------------------------------------------

    it('LINK-NOT-CREATE: link / unlink leave identity_index.PersonCluster (and the deferred Core husk) row-counts bit-identical', async () => {
      const clusterRowsBefore = await countClusterRows();
      const talentRowsBefore = await countTalentRows();
      const overlayRowsBefore = await countOverlayRows();

      const record = await createTalentRecord(recruiterJwt_Ats_SiteA, {
        first: 'BoundaryCheck',
      });

      // Link.
      const link = await postLink(recruiterJwt_Ats_SiteA, record.id, CLUSTER_OK);
      expect(link.status).toBe(200);
      // The keystone boundary: no cluster (and no Core row) was created.
      expect(await countClusterRows()).toBe(clusterRowsBefore);
      expect(await countTalentRows()).toBe(talentRowsBefore);
      expect(await countOverlayRows()).toBe(overlayRowsBefore);

      // Unlink.
      const unlink = await deleteLink(recruiterJwt_Ats_SiteA, record.id);
      expect(unlink.status).toBe(200);
      expect(await countClusterRows()).toBe(clusterRowsBefore);
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
    // D) Proof (3) — REJECT non-existent cluster (guard-4, cluster-exists).
    // -------------------------------------------------------------------------

    it('Reject non-existent cluster_id: 422 TALENT_LINK_INVALID, reason=cluster_not_found', async () => {
      const record = await createTalentRecord(recruiterJwt_Ats_SiteA);
      const link = await postLink(
        recruiterJwt_Ats_SiteA,
        record.id,
        CLUSTER_DOES_NOT_EXIST,
      );
      expect(link.status).toBe(422);
      const body = link.body as {
        error: { code: string; details?: { reason?: string } };
      };
      expect(body.error.code).toBe('TALENT_LINK_INVALID');
      expect(body.error.details?.reason).toBe('cluster_not_found');

      // Refused → pointer unchanged.
      expect(await readClusterId(record.id)).toBeNull();

      await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${record.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    it('Cross-tenant: same global cluster, both tenants link their OWN record; guard-1 isolates each tenant from the other record (404)', async () => {
      // The in-tenant protection is guard-1 (the TalentRecord being linked is
      // in the caller's tenant); the cluster itself is tenant-agnostic.
      const record = await createTalentRecord(recruiterJwt_Ats_SiteA);
      const link = await postLink(recruiterJwt_Ats_SiteA, record.id, CLUSTER_OK);
      expect(link.status).toBe(200);
      expect(await readClusterId(record.id)).toBe(CLUSTER_OK);

      // ISOLATION leg (guard-1): TENANT_OTHER — entitled to ats, correctly
      // scoped + site-matched, so the guards pass — still cannot GET or POST
      // /link on TENANT_ATS's record. The tenant-scoped findById is a read
      // MISS → 404 NOT_FOUND. It MUST be 404, never 403: a 403 on a
      // cross-tenant id would itself leak the record's existence.
      const otherGet = await getLink(recruiterJwt_OtherTenant_SiteA, record.id);
      expect(otherGet.status).toBe(404);
      const otherPost = await postLink(
        recruiterJwt_OtherTenant_SiteA,
        record.id,
        CLUSTER_OK,
      );
      expect(otherPost.status).toBe(404);
      // Neither cross-tenant call mutated the pointer.
      expect(await readClusterId(record.id)).toBe(CLUSTER_OK);

      await deleteLink(recruiterJwt_Ats_SiteA, record.id);
      await fetch(
        `http://127.0.0.1:${port}/v1/talent-records/${record.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );

      // Symmetric proof: TENANT_OTHER links its OWN record to the same cluster.
      const otherRecord = await createTalentRecord(
        recruiterJwt_OtherTenant_SiteA,
      );
      const otherLink = await postLink(
        recruiterJwt_OtherTenant_SiteA,
        otherRecord.id,
        CLUSTER_OK,
      );
      expect(otherLink.status).toBe(200);

      // Cleanup. (No tenant_admin JWT seeded for TENANT_OTHER; a fresh
      // container per run tolerates the dangling record.)
      await deleteLink(recruiterJwt_OtherTenant_SiteA, otherRecord.id);
    });

    // -------------------------------------------------------------------------
    // E) Proof (4) — NULLABLE / UNLINK / IDEMPOTENCY.
    // -------------------------------------------------------------------------

    it('Nullable: an unlinked TalentRecord is valid; GET /link returns is_linked=false; double unlink is idempotent', async () => {
      const record = await createTalentRecord(recruiterJwt_Ats_SiteA);

      // Just-created: unlinked.
      const pre = await getLink(recruiterJwt_Ats_SiteA, record.id);
      expect((pre.body as { is_linked: boolean }).is_linked).toBe(false);

      // Unlink while already unlinked: idempotent.
      const u1 = await deleteLink(recruiterJwt_Ats_SiteA, record.id);
      expect(u1.status).toBe(200);
      expect((u1.body as { is_linked: boolean }).is_linked).toBe(false);
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

    it('Idempotent re-link to the same cluster: 200 no-op; re-link to a DIFFERENT cluster refused with reason=already_linked_to_different_id', async () => {
      const record = await createTalentRecord(recruiterJwt_Ats_SiteA);
      const first = await postLink(recruiterJwt_Ats_SiteA, record.id, CLUSTER_OK);
      expect(first.status).toBe(200);

      // Same cluster again → 200 no-op.
      const same = await postLink(recruiterJwt_Ats_SiteA, record.id, CLUSTER_OK);
      expect(same.status).toBe(200);
      expect((same.body as { is_linked: boolean }).is_linked).toBe(true);

      // Different cluster (also valid): refused — the recruiter must unlink
      // first (defensive against identity confusion).
      const diff = await postLink(
        recruiterJwt_Ats_SiteA,
        record.id,
        CLUSTER_REPLACEMENT,
      );
      expect(diff.status).toBe(422);
      const body = diff.body as {
        error: { code: string; details?: { reason?: string } };
      };
      expect(body.error.code).toBe('TALENT_LINK_INVALID');
      expect(body.error.details?.reason).toBe('already_linked_to_different_id');

      // Original link survives.
      expect(await readClusterId(record.id)).toBe(CLUSTER_OK);

      // Unlink then re-link to the REPLACEMENT — should succeed (the
      // unlink-first protocol).
      await deleteLink(recruiterJwt_Ats_SiteA, record.id);
      const relink = await postLink(
        recruiterJwt_Ats_SiteA,
        record.id,
        CLUSTER_REPLACEMENT,
      );
      expect(relink.status).toBe(200);
      expect(await readClusterId(record.id)).toBe(CLUSTER_REPLACEMENT);

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
    // F) Proof (5a) — I14 WALL. Structural: IdentityIndexRepository carries no
    //    PII-keyed resolution surface (findClusterByEmail / resolveIdentity /
    //    matchIdentity). This is the PII-free-wall property of the REPOSITORY —
    //    NOT the link-path ASSOCIATE-NOT-RESOLVE mechanism (that is pinned by
    //    the TalentLinkService spy unit test + backstopped behaviorally by the
    //    cluster_not_found reject + the LINK-NOT-CREATE row-count proof above).
    //    Opaque HMAC-fingerprint resolve/mint legitimately EXISTS here for the
    //    canonicalization resolver (PII-free by construction); the linker never
    //    calls it.
    // -------------------------------------------------------------------------

    it('I14 wall: IdentityIndexRepository exposes no PII-keyed resolver', () => {
      const protoMethods = Object.getOwnPropertyNames(
        IdentityIndexRepository.prototype,
      ).filter((m) => m !== 'constructor');
      protoMethods.sort();

      // EXPECTED surface: id lookup + opaque-fingerprint (PII-free) resolution
      // + race-safe create. NO PII-keyed resolution method anywhere.
      expect(protoMethods).toEqual([
        'createClusterWithFingerprint',
        'findClusterByFingerprint',
        'findClusterById',
        'findOrCreateClusterByFingerprint',
      ]);

      // The forbidden-name probes — a PII-keyed resolver landing here would
      // breach the I14 PII-free wall + the linker's associate-not-resolve
      // boundary.
      const forbidden = [
        'findClusterByEmail',
        'findByEmail',
        'resolveIdentity',
        'resolveTalent',
        'matchIdentity',
        'searchCluster',
      ];
      for (const name of forbidden) {
        expect(
          protoMethods.includes(name),
          `IdentityIndexRepository must NOT expose a PII-keyed resolution ` +
            `method named ${name} (I14 wall + associate-not-resolve boundary)`,
        ).toBe(false);
      }
    });
  },
);
