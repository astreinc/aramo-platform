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

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// PR-A6 Gate 5+6 (combined) — ATS finishers batch 5 integration spec.
//
// Two leaves, both pure pattern-reuse — NO new design decision (the
// combined-mode guardrail). Proof matrix:
//
//   A) A2-style three-axis gating reused on both /v1/calendar-events
//      and /v1/saved-lists (entitlement / authz / site reject).
//   B) Calendar owner-or-admin edit/delete predicate (the A3 shape):
//      - recruiter edits OWN event → 200.
//      - recruiter edits ANOTHER recruiter's event → 404 NOT_FOUND
//        (A3 info-leak-closing precedent).
//      - tenant_admin edits any event → 200.
//      - tenant_admin DELETE → 204 (recruiter cannot DELETE; the
//        `calendar:event-delete` scope is reserved to tenant_admin).
//   C) Saved-list typed polymorphism (the A4 shape, all 4 paths):
//      - add a talent_record to a talent_record-typed list → 201.
//      - add a mismatched type → 422 SAVED_LIST_ITEM_TYPE_MISMATCH.
//      - add a non-existent item_id → 404 NOT_FOUND.
//      - add a cross-tenant item_id → 404 NOT_FOUND.
//   D) Saved-list homogeneity: a list's item_type fixes its entries'
//      type (covered by C — the mismatch path).
//
// Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
const CALENDAR_INIT = resolve(
  ROOT,
  'libs/calendar/prisma/migrations/20260602120000_init_calendar_model/migration.sql',
);
const SAVED_LIST_INIT = resolve(
  ROOT,
  'libs/saved-list/prisma/migrations/20260602120000_init_saved_list_model/migration.sql',
);
// Promotion-Trigger slice-A — list_kind column; the regenerated SavedList client
// SELECTs it on every list read, so it must be applied after the init.
const SAVED_LIST_LIST_KIND = resolve(
  ROOT,
  'libs/saved-list/prisma/migrations/20260706130000_add_list_kind_tenant_bench/migration.sql',
);
// Saved-list typed-polymorphism validation reads the 4 ATS entity
// repositories. Need their schemas applied so the in-tenant lookups
// can find seeded rows.
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
const CONTACT_INIT = resolve(
  ROOT,
  'libs/contact/prisma/migrations/20260601160000_init_contact_model/migration.sql',
);
const REQUISITION_INIT = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
);
const TALENT_RECORD_INIT = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
);
const TALENT_RECORD_LINK_ADD = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260603020000_add_core_talent_link_to_talent_record/migration.sql',
);
// PR-A8-1 — additive back-reference columns on the 4 ATS targets.
// The Prisma client's RETURNING projection includes import_batch_id;
// absent in DB → 500 INTERNAL_ERROR on POST create.
const COMPANY_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260603140100_add_import_batch_id_to_company/migration.sql',
);
const CONTACT_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/contact/prisma/migrations/20260603140100_add_import_batch_id_to_contact/migration.sql',
);
const CONTACT_LIST_SURFACE_FIELDS = resolve(
  ROOT,
  'libs/contact/prisma/migrations/20260618120000_add_contact_list_surface_fields/migration.sql',
);
const REQUISITION_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260603140100_add_import_batch_id_to_requisition/migration.sql',
);
// Compensation-Field Modeling v1.1 — 2 enums + 10 nullable comp cols.
const REQUISITION_COMPENSATION_FIELDS = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260605123400_add_compensation_fields_to_requisition/migration.sql',
);
// Job-Module — enterprise + financial + golden_profile_id columns. The
// repository's RETURNING projection includes them; absent in DB → 500 on
// every requisition write/read (the documented migration-harness gap:
// per-spec MIGRATIONS lists are hardcoded, not auto-discovered).
const REQUISITION_JOB_MODULE_FIELDS = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260611220000_job_module_requisition_fields/migration.sql',
);
// New Requisition (Requisition Record Spec Amendment v1.0) — rate_type +
// allow_subcontractors + run_match_on_create. Additive; applied last.
const REQUISITION_RATE_TYPE_SUBK = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260618120000_add_rate_type_subk_runmatch/migration.sql',
);
const REQUISITION_PUBLISH_SURFACE_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260721000000_add_publish_surface/migration.sql',
);
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
// 4d — overlay-fold columns + cluster_id (TalentRecord RETURNING projects them).
const TALENT_RECORD_OVERLAY_FOLD = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260630140000_overlay_fold_cluster_id/migration.sql',
);
// Gate-1 G1-A — work_authorization column (regenerated client projects it).
const TALENT_RECORD_WORK_AUTH = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260702120000_add_work_authorization_to_talent_record/migration.sql',
);
// TR-2a-B3a (DDR-3 §3) — record_status / superseded_* columns (regenerated client
// projects them; TalentRecord RETURNING/findFirst 500s without them).
const TALENT_RECORD_SUPERSESSION = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260706210000_tr2a_b3a_talent_record_supersession/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-ats-batch5-calendar-saved-list-spec';
const ALG = 'RS256';

const TENANT_ATS = '01900000-0000-7000-8000-000000000001';
const TENANT_OTHER = '55555555-5555-7555-8555-555555555555';
const TENANT_NOT_ATS = '22222222-2222-7222-8222-222222222222';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';
const SITE_B = '44444444-4444-7444-8444-4444444444bb';

const RECRUITER_OWNER = '00000000-0000-7000-8000-000000000bb1';
const RECRUITER_OTHER = '00000000-0000-7000-8000-000000000bb2';
const TENANT_ADMIN = '00000000-0000-7000-8000-000000000aa1';

// Recruiter divergence (Ruling 1): no :delete scopes.
const RECRUITER_SCOPES = [
  'calendar:event-create',
  'calendar:event-edit',
  // saved-list:* scopes are NOT in the seed catalog at A6 (gap-and-note
  // per directive §9). The spec passes them in the JWT directly — the
  // RolesGuard reads them from the token, not from the seeded catalog.
  'saved-list:read',
  'saved-list:create',
  'saved-list:edit',
  // For the C/D paths the recruiter needs entity-create scopes too.
  'talent:create',
  'company:create',
  'contact:create',
  'requisition:create',
];
const TENANT_ADMIN_SCOPES = [
  ...RECRUITER_SCOPES,
  'calendar:event-delete',
  'saved-list:delete',
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-A6 ATS finishers — calendar + saved-list proofs (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let setupClient: Client;

    let recruiterOwnerJwt: string;
    let recruiterOtherJwt: string;
    let recruiterJwt_NotAts: string;
    let recruiterJwt_WrongSite: string;
    let unscopedJwt: string;
    let tenantAdminJwt: string;
    let recruiterJwt_OtherTenant: string;

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

      for (const p of [
        ENTITLEMENT_INIT,
        CALENDAR_INIT,
        SAVED_LIST_INIT,
        SAVED_LIST_LIST_KIND,
        COMPANY_INIT,
        COMPANY_FIELD_EXPANSION,
        COMPANY_ADDRESS_PLACE_REF,
        COMPANY_OFF_LIMITS,
        COMPANY_IMPORT_BACK_REF,
        CONTACT_INIT,
        CONTACT_IMPORT_BACK_REF,
        CONTACT_LIST_SURFACE_FIELDS,
        REQUISITION_INIT,
        REQUISITION_IMPORT_BACK_REF,
        REQUISITION_COMPENSATION_FIELDS, REQUISITION_JOB_MODULE_FIELDS, REQUISITION_RATE_TYPE_SUBK, REQUISITION_PUBLISH_SURFACE_MIGRATION,
        TALENT_RECORD_INIT,
        TALENT_RECORD_LINK_ADD,
        TALENT_RECORD_IMPORT_BACK_REF,
        TALENT_RECORD_STATED_FIELDS,
        TALENT_RECORD_OVERLAY_FOLD,
        TALENT_RECORD_WORK_AUTH,
        TALENT_RECORD_SUPERSESSION,
      ]) {
        await setupClient.query(readFileSync(p, 'utf8'));
      }

      // Inc-3 PR-3.7 — the global write-freeze interceptor reads identity.Tenant
      // status on every mutation; seed an ACTIVE tenant for each forged tenant_id.
      await ensureWriteFreezeTenant((s) => setupClient.query(s), TENANT_ATS);
      await ensureWriteFreezeTenant((s) => setupClient.query(s), TENANT_OTHER);
      await ensureWriteFreezeTenant((s) => setupClient.query(s), TENANT_NOT_ATS);

      // Entitle TENANT_ATS + TENANT_OTHER (the cross-tenant probe needs
      // both entitled so the rejection comes from the typed-polymorphism
      // owner check, not the entitlement gate).
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

      recruiterOwnerJwt = await signJwt(privateKey, {
        sub: RECRUITER_OWNER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });
      recruiterOtherJwt = await signJwt(privateKey, {
        sub: RECRUITER_OTHER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });
      recruiterJwt_NotAts = await signJwt(privateKey, {
        sub: RECRUITER_OWNER,
        tenant_id: TENANT_NOT_ATS,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });
      recruiterJwt_WrongSite = await signJwt(privateKey, {
        sub: RECRUITER_OWNER,
        tenant_id: TENANT_ATS,
        site_id: SITE_B,
        scopes: RECRUITER_SCOPES,
      });
      unscopedJwt = await signJwt(privateKey, {
        sub: RECRUITER_OWNER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: [],
      });
      tenantAdminJwt = await signJwt(privateKey, {
        sub: TENANT_ADMIN,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: TENANT_ADMIN_SCOPES,
      });
      recruiterJwt_OtherTenant = await signJwt(privateKey, {
        sub: RECRUITER_OWNER,
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
    // A) Three-axis gating reuse on calendar + saved-list.
    // -------------------------------------------------------------------------

    it('Calendar entitlement axis: tenant lacking ats → 403 TENANT_CAPABILITY_NOT_ENTITLED', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/calendar-events?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterJwt_NotAts}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('TENANT_CAPABILITY_NOT_ENTITLED');
    });

    it('Calendar authorization axis: unscoped → 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/calendar-events?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${unscopedJwt}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('Calendar site axis: token site != requested site → 403', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/calendar-events?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterJwt_WrongSite}` },
      });
      expect(res.status).toBe(403);
    });

    it('Saved-list entitlement axis: tenant lacking ats → 403 TENANT_CAPABILITY_NOT_ENTITLED', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/saved-lists?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterJwt_NotAts}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('TENANT_CAPABILITY_NOT_ENTITLED');
    });

    it('Saved-list authorization axis: unscoped → 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/saved-lists?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${unscopedJwt}` },
      });
      expect(res.status).toBe(403);
    });

    it('Saved-list site axis: token site != requested site → 403', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/saved-lists?site_id=${SITE_A}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterJwt_WrongSite}` },
      });
      expect(res.status).toBe(403);
    });

    // -------------------------------------------------------------------------
    // B) Calendar owner-or-admin predicate (the A3 shape).
    // -------------------------------------------------------------------------

    it('Calendar predicate: recruiter edits OWN event → 200; another recruiter → 404; tenant_admin → 200; DELETE recruiter → 403, admin → 204', async () => {
      // Owner recruiter creates an event.
      const createRes = await fetch(
        `http://127.0.0.1:${port}/v1/calendar-events?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterOwnerJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'meeting',
            title: 'Owner-only',
            starts_at: '2026-07-01T10:00:00Z',
            ends_at: '2026-07-01T11:00:00Z',
            site_id: SITE_A,
          }),
        },
      );
      expect(createRes.status).toBe(201);
      const event = (await createRes.json()) as { id: string; owner_id: string };
      expect(event.owner_id).toBe(RECRUITER_OWNER);

      // Owner edits → 200.
      const ownerEdit = await fetch(
        `http://127.0.0.1:${port}/v1/calendar-events/${event.id}?site_id=${SITE_A}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${recruiterOwnerJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: 'Owner-edited' }),
        },
      );
      expect(ownerEdit.status).toBe(200);
      const ownerEdited = (await ownerEdit.json()) as { title: string };
      expect(ownerEdited.title).toBe('Owner-edited');

      // Another recruiter edits → 404 (A3 info-leak-closing precedent).
      const otherEdit = await fetch(
        `http://127.0.0.1:${port}/v1/calendar-events/${event.id}?site_id=${SITE_A}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${recruiterOtherJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: 'Hostile takeover' }),
        },
      );
      expect(otherEdit.status).toBe(404);
      const otherBody = (await otherEdit.json()) as { error: { code: string } };
      expect(otherBody.error?.code).toBe('NOT_FOUND');

      // Tenant_admin edits → 200 (the see-all-edit-all tier).
      const adminEdit = await fetch(
        `http://127.0.0.1:${port}/v1/calendar-events/${event.id}?site_id=${SITE_A}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${tenantAdminJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: 'Admin-edited' }),
        },
      );
      expect(adminEdit.status).toBe(200);

      // Recruiter DELETE → 403 (Ruling 1: tenant_admin only).
      const recDel = await fetch(
        `http://127.0.0.1:${port}/v1/calendar-events/${event.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${recruiterOwnerJwt}` },
        },
      );
      expect(recDel.status).toBe(403);

      // Tenant_admin DELETE → 204.
      const adminDel = await fetch(
        `http://127.0.0.1:${port}/v1/calendar-events/${event.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt}` },
        },
      );
      expect(adminDel.status).toBe(204);
    });

    // -------------------------------------------------------------------------
    // C/D) Saved-list typed polymorphism (the A4 shape, all 4 paths) +
    //      homogeneity invariant.
    // -------------------------------------------------------------------------

    it('Saved-list polymorphism + homogeneity: real talent_record → 201; mismatched type → 422; non-existent item_id → 404; cross-tenant item_id → 404', async () => {
      // Seed a TalentRecord in TENANT_ATS.
      const tRes = await fetch(`http://127.0.0.1:${port}/v1/talent-records?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterOwnerJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          first_name: 'List',
          last_name: 'Member',
          site_id: SITE_A,
        }),
      });
      expect(tRes.status).toBe(201);
      const talent = (await tRes.json()) as { id: string };

      // Create a talent_record-typed SavedList.
      const listRes = await fetch(`http://127.0.0.1:${port}/v1/saved-lists?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterOwnerJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'My talents',
          item_type: 'talent_record',
          site_id: SITE_A,
        }),
      });
      expect(listRes.status).toBe(201);
      const list = (await listRes.json()) as { id: string; item_type: string };
      expect(list.item_type).toBe('talent_record');

      // 1. Add real in-tenant talent_record → 201.
      const okAdd = await fetch(
        `http://127.0.0.1:${port}/v1/saved-lists/${list.id}/entries?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterOwnerJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ item_type: 'talent_record', item_id: talent.id }),
        },
      );
      expect(okAdd.status).toBe(201);

      // 2. Mismatched type → 422 SAVED_LIST_ITEM_TYPE_MISMATCH
      //    (homogeneity invariant — parent list is talent_record-typed).
      const mismatchAdd = await fetch(
        `http://127.0.0.1:${port}/v1/saved-lists/${list.id}/entries?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterOwnerJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ item_type: 'company', item_id: talent.id }),
        },
      );
      expect(mismatchAdd.status).toBe(422);
      const mmBody = (await mismatchAdd.json()) as { error: { code: string } };
      expect(mmBody.error?.code).toBe('SAVED_LIST_ITEM_TYPE_MISMATCH');

      // 3. Non-existent item_id (same tenant) → 404 NOT_FOUND
      //    (typed-polymorphism owner validation refusal).
      const nonExistentAdd = await fetch(
        `http://127.0.0.1:${port}/v1/saved-lists/${list.id}/entries?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterOwnerJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            item_type: 'talent_record',
            item_id: '99999999-9999-7999-8999-999999999999',
          }),
        },
      );
      expect(nonExistentAdd.status).toBe(404);

      // 4. Cross-tenant item_id → 404 NOT_FOUND. Seed a TalentRecord in
      //    TENANT_OTHER, then try to add it to the TENANT_ATS list.
      const otherTalentRes = await fetch(
        `http://127.0.0.1:${port}/v1/talent-records?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterJwt_OtherTenant}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            first_name: 'Cross',
            last_name: 'Tenant',
            site_id: SITE_A,
          }),
        },
      );
      expect(otherTalentRes.status).toBe(201);
      const otherTalent = (await otherTalentRes.json()) as { id: string };

      const crossTenantAdd = await fetch(
        `http://127.0.0.1:${port}/v1/saved-lists/${list.id}/entries?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterOwnerJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            item_type: 'talent_record',
            item_id: otherTalent.id,
          }),
        },
      );
      expect(crossTenantAdd.status).toBe(404);
    });

    it('Saved-list polymorphism wires all 4 entity types (company / contact / requisition / talent_record)', async () => {
      // Seed one of each in TENANT_ATS.
      const compRes = await fetch(`http://127.0.0.1:${port}/v1/companies?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterOwnerJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Polymorphic Co', site_id: SITE_A }),
      });
      expect(compRes.status).toBe(201);
      const company = (await compRes.json()) as { id: string };

      const contactRes = await fetch(`http://127.0.0.1:${port}/v1/contacts?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterOwnerJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          company_id: company.id,
          first_name: 'Poly',
          last_name: 'Contact',
          email1: 'poly@example.com',
          site_id: SITE_A,
        }),
      });
      expect(contactRes.status).toBe(201);
      const contact = (await contactRes.json()) as { id: string };

      const reqRes = await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE_A}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterOwnerJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Polymorphic Req',
          company_id: company.id,
          site_id: SITE_A,
        }),
      });
      expect(reqRes.status).toBe(201);
      const req = (await reqRes.json()) as { id: string };

      // For each of company / contact / requisition: create a list of that
      // type and add the corresponding entity. All should succeed.
      for (const [item_type, item_id] of [
        ['company', company.id],
        ['contact', contact.id],
        ['requisition', req.id],
      ] as const) {
        const list = await fetch(`http://127.0.0.1:${port}/v1/saved-lists?site_id=${SITE_A}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${recruiterOwnerJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: `${item_type} list`,
            item_type,
            site_id: SITE_A,
          }),
        });
        expect(list.status).toBe(201);
        const listJson = (await list.json()) as { id: string };

        const addEntry = await fetch(
          `http://127.0.0.1:${port}/v1/saved-lists/${listJson.id}/entries?site_id=${SITE_A}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${recruiterOwnerJwt}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ item_type, item_id }),
          },
        );
        expect(addEntry.status).toBe(201);
      }
    });
  },
);
