import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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
import { RequisitionRepository } from '@aramo/requisition';

import { AppModule } from '../app.module.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';
import { placementCapacityMigrations } from './support/placement-capacity-migrations.js';

// L1-B — Requisition WRITE-visibility parity (closes recon defect D2).
//
// The one question: "Can a normal human mutation reach a Requisition the actor
// is not entitled to SEE?" After L1-B: No — update (PATCH) and delete (DELETE)
// fold the SAME read-side visibility predicate (buildVisibilityWhere +
// findByIdForActor null-on-invisible) into their existence read, so an
// out-of-visibility requisition collapses to the EXISTING 404 — indistinguishable
// from a nonexistent one for any actor with enough route/application authority to
// ATTEMPT the op.
//
// Mirrors authz-d4b-visibility-matrix.integration.spec.ts matrix-6 (the A3 OR-arm
// setup): actors resolve visibility via the same UserClientAssignment /
// RequisitionAssignment substrate. Non-vacuous: for each 404-on-invisible proof an
// admin/see-all actor 200/204s the SAME row (proves concealment, not absence).

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

const IDENTITY_INIT = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
);
const IDENTITY_ALLOWED_DOMAIN = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260625000000_add_tenant_allowed_domain/migration.sql',
);
const IDENTITY_DOMAIN_VERIFICATION = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260626000000_add_tenant_domain_verification/migration.sql',
);
const IDENTITY_SLUG = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260626120000_add_tenant_slug/migration.sql',
);
const IDENTITY_IDP = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql',
);
const IDENTITY_IDP_LC = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260709130000_add_tenant_lifecycle_status/migration.sql',
);
const IDENTITY_INVITATION_MIG = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
);
const IDENTITY_SITE_AXIS = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260601000000_add_site_axis/migration.sql',
);
const IDENTITY_D4A = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260604000000_add_authz_team_models/migration.sql',
);
const IDENTITY_PROFILE = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260619000000_add_tenant_profile/migration.sql',
);
const IDENTITY_SITE_HIERARCHY = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260620000000_add_site_hierarchy/migration.sql',
);
const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
const COMPANY_INIT = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260601160000_init_company_model/migration.sql',
);
const COMPANY_FIELD_EXPANSION = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260611000000_add_company_field_expansion/migration.sql',
);
const COMPANY_ADDRESS_PLACE_REF = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260611120000_add_company_address_place_ref/migration.sql',
);
const COMPANY_OFF_LIMITS = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260616000000_add_company_off_limits/migration.sql',
);
const COMPANY_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260603140100_add_import_batch_id_to_company/migration.sql',
);
const COMPANY_D4A = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260604000000_add_authz_assignment_ownership/migration.sql',
);
const REQUISITION_INIT = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
);
const REQUISITION_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260603140100_add_import_batch_id_to_requisition/migration.sql',
);
const REQUISITION_COMPENSATION_FIELDS = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260605123400_add_compensation_fields_to_requisition/migration.sql',
);
const REQUISITION_JOB_MODULE_FIELDS = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260611220000_job_module_requisition_fields/migration.sql',
);
const REQUISITION_RATE_TYPE_SUBK = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260618120000_add_rate_type_subk_runmatch/migration.sql',
);
const REQUISITION_PUBLISH_SURFACE_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260721000000_add_publish_surface/migration.sql',
);
const REQUISITION_LIFECYCLE_EVENT_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260731120000_add_requisition_lifecycle_event/migration.sql',
);
const REQUISITION_LIFECYCLE_NULLABLE_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260802120000_lifecycle_previous_status_nullable/migration.sql',
);
const REQUISITION_VERSION_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260801120000_add_version_to_requisition/migration.sql',
);
const REQUISITION_ONSITE_DAYS_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260802140000_add_onsite_days_to_requisition/migration.sql',
);
const REQUISITION_NUMBER_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260802180000_add_requisition_number/migration.sql',
);
const REQUISITION_USER_STATE_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260802160000_add_user_requisition_state/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-l1b-write-visibility-spec';
const ALG = 'RS256';

const TENANT_ATS = '01900000-0000-7000-8000-0000000000b1';
const TENANT_OTHER = '01900000-0000-7000-8000-0000000000b2';
const SITE_A = '33333333-3333-7333-8333-3333333333bb';

// Principals.
const TENANT_ADMIN_U = '00000000-0000-7000-8000-00000000b001';
const EDITOR_U = '00000000-0000-7000-8000-00000000b002'; // client-axis editor (companyVisible)
const STATUS_EDITOR_U = '00000000-0000-7000-8000-00000000b003'; // status-only tier (companyVisible)
const A3_EDITOR_U = '00000000-0000-7000-8000-00000000b004'; // no client-axis; direct req-assignment
const THROWAWAY_U = '00000000-0000-7000-8000-00000000b005'; // assign/unassign regression target
const TENANT_OTHER_ADMIN_U = '00000000-0000-7000-8000-00000000b006';

// TA sets up the world + is the see-all / admin actor for the non-vacuous
// baselines (requisition:read:all -> see_all_requisition -> no visibility filter).
const TA_SCOPES = [
  'company:read',
  'company:create',
  'company:edit',
  'company:assign',
  'org:manage',
  'team:manage',
  'company:read:all',
  'requisition:read',
  'requisition:read:all',
  'requisition:create',
  'requisition:edit',
  'requisition:edit:status',
  'requisition:delete',
  'requisition:assign',
  'requisition:import:write',
  'contact:read',
  'pipeline:read',
];
// Ordinary editor — holds full edit + delete, but NO read:all (visibility is
// resolved by the client/A3 arms, exactly like the read side).
const EDITOR_SCOPES = [
  'company:read',
  'contact:read',
  'pipeline:read',
  'requisition:read',
  'requisition:edit',
  'requisition:delete',
];
// Status-only tier — requisition:edit:status, NO requisition:edit / :delete.
const STATUS_EDITOR_SCOPES = [
  'company:read',
  'contact:read',
  'pipeline:read',
  'requisition:read',
  'requisition:edit:status',
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L1-B — Requisition write-visibility parity (update/delete conceal invisible rows with 404)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let setupClient: Client;

    let taJwt: string;
    let editorJwt: string;
    let statusEditorJwt: string;
    let a3EditorJwt: string;
    let taOtherJwt: string;

    let companyVisible = '';
    let companyInvisible = '';
    let companyOther = '';

    let reqVisible = '';
    let reqInvisible = '';
    let reqDeleteVisible = '';
    let reqDeleteInvisible = '';
    let reqA3 = '';
    let reqCrossTenant = '';

    async function signJwt(
      privateKey: SignKey,
      args: { sub: string; scopes: string[]; tenant_id?: string },
    ): Promise<string> {
      return new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: args.tenant_id ?? TENANT_ATS,
        scopes: args.scopes,
        site_id: SITE_A,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);
    }

    async function seedUser(userId: string): Promise<void> {
      await setupClient.query(
        `INSERT INTO identity."User" (id, email, display_name, is_active, updated_at)
         VALUES ($1::uuid, $2, $3, true, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO NOTHING`,
        [userId, `${userId.slice(-8)}@l1b.test`, `User ${userId.slice(-4)}`],
      );
    }

    async function createCompany(
      jwt: string,
      name: string,
      tenant_id = TENANT_ATS,
    ): Promise<string> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/companies?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name, site_id: SITE_A }),
        },
      );
      expect(res.status, `createCompany(${name}) in ${tenant_id}`).toBe(201);
      return ((await res.json()) as { id: string }).id;
    }

    async function createRequisition(
      jwt: string,
      title: string,
      company_id: string,
    ): Promise<string> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title, company_id, site_id: SITE_A }),
        },
      );
      expect(res.status, `createRequisition(${title})`).toBe(201);
      return ((await res.json()) as { id: string }).id;
    }

    async function assignUserToCompany(
      user_id: string,
      company_id: string,
    ): Promise<void> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/companies/${company_id}/assignments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${taJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id }),
        },
      );
      expect([200, 201]).toContain(res.status);
    }

    async function assignReqDirectly(
      requisition_id: string,
      user_id: string,
    ): Promise<{ status: number }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${requisition_id}/assignments?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${taJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id }),
        },
      );
      return { status: res.status };
    }

    async function unassignReqDirectly(
      requisition_id: string,
      user_id: string,
    ): Promise<{ status: number }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${requisition_id}/assignments/${user_id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${taJwt}` },
        },
      );
      return { status: res.status };
    }

    async function getReq(jwt: string, id: string): Promise<{ status: number }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${id}?site_id=${SITE_A}`,
        { headers: { Authorization: `Bearer ${jwt}` } },
      );
      return { status: res.status };
    }

    async function patchReq(
      jwt: string,
      id: string,
      body: Record<string, unknown>,
    ): Promise<{ status: number; body: unknown }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${id}?site_id=${SITE_A}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    }

    async function deleteReq(
      jwt: string,
      id: string,
    ): Promise<{ status: number }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${jwt}` },
        },
      );
      return { status: res.status };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new Client({ connectionString: url });
      await setupClient.connect();

      for (const p of [
        IDENTITY_INIT,
        IDENTITY_ALLOWED_DOMAIN,
        IDENTITY_DOMAIN_VERIFICATION,
        IDENTITY_SLUG,
        IDENTITY_IDP,
        IDENTITY_IDP_LC,
        IDENTITY_INVITATION_MIG,
        IDENTITY_SITE_AXIS,
        IDENTITY_D4A,
        IDENTITY_PROFILE,
        IDENTITY_SITE_HIERARCHY,
        ENTITLEMENT_INIT,
        COMPANY_INIT,
        COMPANY_FIELD_EXPANSION,
        COMPANY_ADDRESS_PLACE_REF,
        COMPANY_OFF_LIMITS,
        COMPANY_IMPORT_BACK_REF,
        COMPANY_D4A,
        REQUISITION_INIT,
        REQUISITION_IMPORT_BACK_REF,
        REQUISITION_COMPENSATION_FIELDS,
        REQUISITION_JOB_MODULE_FIELDS,
        REQUISITION_RATE_TYPE_SUBK,
        REQUISITION_PUBLISH_SURFACE_MIGRATION,
        REQUISITION_LIFECYCLE_EVENT_MIGRATION,
        REQUISITION_VERSION_MIGRATION,
        REQUISITION_ONSITE_DAYS_MIGRATION,
        REQUISITION_NUMBER_MIGRATION,
        REQUISITION_LIFECYCLE_NULLABLE_MIGRATION,
        REQUISITION_USER_STATE_MIGRATION,
        resolve(
          ROOT,
          'libs/requisition/prisma/migrations/20260803120000_recruiting_status_supersession/migration.sql',
        ),
        ...placementCapacityMigrations(ROOT),
      ]) {
        await setupClient.query(readFileSync(p, 'utf8'));
      }

      await ensureWriteFreezeTenant((s) => setupClient.query(s), TENANT_ATS);
      await ensureWriteFreezeTenant((s) => setupClient.query(s), TENANT_OTHER);

      for (const t of [TENANT_ATS, TENANT_OTHER]) {
        await setupClient.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
           VALUES ($1::uuid, 'ats')
           ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [t],
        );
      }

      for (const u of [
        TENANT_ADMIN_U,
        EDITOR_U,
        STATUS_EDITOR_U,
        A3_EDITOR_U,
        THROWAWAY_U,
        TENANT_OTHER_ADMIN_U,
      ]) {
        await seedUser(u);
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

      taJwt = await signJwt(privateKey, {
        sub: TENANT_ADMIN_U,
        scopes: TA_SCOPES,
      });
      editorJwt = await signJwt(privateKey, {
        sub: EDITOR_U,
        scopes: EDITOR_SCOPES,
      });
      statusEditorJwt = await signJwt(privateKey, {
        sub: STATUS_EDITOR_U,
        scopes: STATUS_EDITOR_SCOPES,
      });
      a3EditorJwt = await signJwt(privateKey, {
        sub: A3_EDITOR_U,
        scopes: EDITOR_SCOPES,
      });
      taOtherJwt = await signJwt(privateKey, {
        sub: TENANT_OTHER_ADMIN_U,
        scopes: TA_SCOPES,
        tenant_id: TENANT_OTHER,
      });

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: false,
          transform: true,
        }),
      );
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;

      // Seed the world — TA (see-all) does all setup writes.
      companyVisible = await createCompany(taJwt, 'L1-B Visible Client');
      companyInvisible = await createCompany(taJwt, 'L1-B Invisible Client');
      companyOther = await createCompany(taOtherJwt, 'L1-B Other-Tenant Client', TENANT_OTHER);

      reqVisible = await createRequisition(taJwt, 'L1-B Visible Req', companyVisible);
      reqInvisible = await createRequisition(taJwt, 'L1-B Invisible Req', companyInvisible);
      reqDeleteVisible = await createRequisition(taJwt, 'L1-B Delete-Visible Req', companyVisible);
      reqDeleteInvisible = await createRequisition(taJwt, 'L1-B Delete-Invisible Req', companyInvisible);
      // reqA3 lives at the INVISIBLE client (no client-axis for A3_EDITOR) but
      // A3_EDITOR gets a DIRECT RequisitionAssignment -> the A3 OR-arm.
      reqA3 = await createRequisition(taJwt, 'L1-B A3 Req', companyInvisible);
      reqCrossTenant = await createRequisition(taOtherJwt, 'L1-B Cross-Tenant Req', companyOther);

      // EDITOR + STATUS_EDITOR see companyVisible via a direct client assignment.
      await assignUserToCompany(EDITOR_U, companyVisible);
      await assignUserToCompany(STATUS_EDITOR_U, companyVisible);
      // A3_EDITOR: no client visibility; direct requisition assignment only.
      const a3Assign = await assignReqDirectly(reqA3, A3_EDITOR_U);
      expect([200, 201]).toContain(a3Assign.status);
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

    // ----------------------------------------------------------------------
    // P1 — visible req + valid edit authority -> update 200 (client-axis arm
    //      resolves on the WRITE path for an ordinary actor).
    // ----------------------------------------------------------------------
    it('P1 — editor updates a VISIBLE requisition (client-axis) -> 200', async () => {
      const res = await patchReq(editorJwt, reqVisible, { title: 'L1-B P1 edit' });
      expect(res.status).toBe(200);
      expect((res.body as { title: string }).title).toBe('L1-B P1 edit');
    });

    // ----------------------------------------------------------------------
    // P2 — invisible same-tenant req + valid edit authority -> 404.
    //      Non-vacuous: the see-all admin 200s the SAME row FIRST (the 404 is
    //      concealment, not absence).
    // ----------------------------------------------------------------------
    it('P2 — admin 200s reqInvisible FIRST; then editor update -> 404 (concealment)', async () => {
      const adminEdit = await patchReq(taJwt, reqInvisible, {
        title: 'L1-B admin-can-reach',
      });
      expect(adminEdit.status).toBe(200);
      expect((adminEdit.body as { title: string }).title).toBe('L1-B admin-can-reach');

      const editorEdit = await patchReq(editorJwt, reqInvisible, {
        title: 'L1-B editor-must-not-reach',
      });
      expect(editorEdit.status).toBe(404);
    });

    // ----------------------------------------------------------------------
    // P3 — invisible same-tenant req + STATUS-edit authority -> 404. The
    //      status-only scope gate passes (status field allowed) but the
    //      visibility 404 rides inside the existence read.
    // ----------------------------------------------------------------------
    it('P3 — admin sees reqInvisible; status-only editor update -> 404 (concealment)', async () => {
      expect((await getReq(taJwt, reqInvisible)).status).toBe(200);
      const res = await patchReq(statusEditorJwt, reqInvisible, { status: 'open' });
      expect(res.status).toBe(404);
    });

    // ----------------------------------------------------------------------
    // P4 — cross-tenant req remains inaccessible (unchanged tenant isolation).
    //      Non-vacuous: the OTHER tenant's admin 200s the SAME row FIRST.
    // ----------------------------------------------------------------------
    it('P4 — other-tenant admin 200s reqCrossTenant FIRST; ATS editor update -> 404', async () => {
      const owner = await patchReq(taOtherJwt, reqCrossTenant, {
        title: 'L1-B cross-tenant owner edit',
      });
      expect(owner.status).toBe(200);

      const crosser = await patchReq(editorJwt, reqCrossTenant, {
        title: 'L1-B cross-tenant intruder edit',
      });
      expect(crosser.status).toBe(404);
    });

    // ----------------------------------------------------------------------
    // P5 — visible req + valid delete authority -> 204.
    // ----------------------------------------------------------------------
    it('P5 — editor deletes a VISIBLE requisition -> 204', async () => {
      const res = await deleteReq(editorJwt, reqDeleteVisible);
      expect(res.status).toBe(204);
      // The row is genuinely gone (admin can no longer see it).
      expect((await getReq(taJwt, reqDeleteVisible)).status).toBe(404);
    });

    // ----------------------------------------------------------------------
    // P6 — invisible req + valid delete authority -> 404 (concealment).
    //      Non-vacuous on the SAME row: admin sees it BEFORE (200), the editor
    //      404 leaves it intact (admin still sees it 200), and the admin then
    //      genuinely deletes it (204) — proving the editor 404 was concealment.
    // ----------------------------------------------------------------------
    it('P6 — admin sees reqDeleteInvisible; editor delete -> 404; row intact; admin delete -> 204', async () => {
      expect((await getReq(taJwt, reqDeleteInvisible)).status).toBe(200);

      const editorDelete = await deleteReq(editorJwt, reqDeleteInvisible);
      expect(editorDelete.status).toBe(404);

      // The concealment 404 must NOT have deleted the row.
      expect((await getReq(taJwt, reqDeleteInvisible)).status).toBe(200);

      // ...and the row was genuinely deletable all along (admin -> 204).
      const adminDelete = await deleteReq(taJwt, reqDeleteInvisible);
      expect(adminDelete.status).toBe(204);
      expect((await getReq(taJwt, reqDeleteInvisible)).status).toBe(404);
    });

    // ----------------------------------------------------------------------
    // P7 — CAS/version behaviour for VISIBLE updates unchanged (stale -> 409).
    // ----------------------------------------------------------------------
    it('P7 — visible update with a stale version -> 409 (CAS unchanged)', async () => {
      const res = await patchReq(editorJwt, reqVisible, {
        title: 'L1-B P7 stale',
        version: 99999,
      });
      expect(res.status).toBe(409);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        'REQUISITION_VERSION_CONFLICT',
      );
    });

    // ----------------------------------------------------------------------
    // P8 — existing authorization errors for VISIBLE resources unchanged (the
    //      scope/field gates stay AHEAD of the existence read; a row-independent
    //      403 leaks no existence). Both the status-only field 403 and the
    //      financial-scope 403 fire on a genuinely visible row.
    // ----------------------------------------------------------------------
    it('P8 — visible req: status-only non-status field -> 403; editor financial field -> 403', async () => {
      const statusOnly = await patchReq(statusEditorJwt, reqVisible, {
        title: 'L1-B P8 not-allowed',
      });
      expect(statusOnly.status).toBe(403);

      const financial = await patchReq(editorJwt, reqVisible, {
        target_margin_percent: '12.5',
      });
      expect(financial.status).toBe(403);
    });

    // ----------------------------------------------------------------------
    // P9 — REGRESSION: the change does NOT collapse admin/A3 visibility into
    //      ordinary-recruiter visibility. An ordinary actor with a DIRECT
    //      RequisitionAssignment (the A3 OR-arm) still mutates a req whose
    //      client it cannot see; the see-all admin still mutates across the
    //      tenant (P2/P4/P6 baselines already proved the admin arm).
    // ----------------------------------------------------------------------
    it('P9 — A3 OR-arm resolves on the write path: direct-req-assigned editor update -> 200', async () => {
      // A3_EDITOR has NO client-axis visibility of companyInvisible...
      const clientAxis = await patchReq(a3EditorJwt, reqInvisible, {
        title: 'L1-B A3 must-not-reach-unassigned',
      });
      expect(clientAxis.status).toBe(404);
      // ...but DOES reach reqA3 via the direct RequisitionAssignment (A3 arm).
      const a3 = await patchReq(a3EditorJwt, reqA3, { title: 'L1-B A3 reach' });
      expect(a3.status).toBe(200);
      expect((a3.body as { title: string }).title).toBe('L1-B A3 reach');
    });

    // ----------------------------------------------------------------------
    // P10 — REGRESSION: assign/unassign semantics UNCHANGED (admin-tier
    //       requisition:assign, NOT visibility-gated). TA assigns a throwaway
    //       user onto reqInvisible (a row invisible to the edit actor) and
    //       unassigns — both succeed, proving L1-B did not touch that path.
    // ----------------------------------------------------------------------
    it('P10 — assign/unassign on an edit-actor-invisible req unchanged (admin-tier)', async () => {
      const assigned = await assignReqDirectly(reqInvisible, THROWAWAY_U);
      expect([200, 201]).toContain(assigned.status);
      const unassigned = await unassignReqDirectly(reqInvisible, THROWAWAY_U);
      expect(unassigned.status).toBe(204);
    });

    // ----------------------------------------------------------------------
    // P11 — REGRESSION: deleteByImportBatch (system/import cleanup, no HTTP
    //       route, no visibility param) UNCHANGED. Seed a batch via
    //       createForImport, then reversion removes it regardless of any
    //       actor visibility.
    // ----------------------------------------------------------------------
    it('P11 — deleteByImportBatch (system path) unchanged — no visibility param', async () => {
      const repo = app.get(RequisitionRepository, { strict: false });
      const batchId = randomUUID();
      const imported = (await repo.createForImport({
        tenant_id: TENANT_ATS,
        entered_by_id: TENANT_ADMIN_U,
        import_batch_id: batchId,
        input: {
          title: 'L1-B Imported Req',
          company_id: companyInvisible,
          status: 'open',
          site_id: SITE_A,
        } as never,
        scopes: ['requisition:import:write'],
        requestId: randomUUID(),
      })) as unknown as { id: string };
      expect((await getReq(taJwt, imported.id)).status).toBe(200);

      const count = await repo.deleteByImportBatch({
        tenant_id: TENANT_ATS,
        import_batch_id: batchId,
      });
      expect(count).toBe(1);
      expect((await getReq(taJwt, imported.id)).status).toBe(404);
    });
  },
);
