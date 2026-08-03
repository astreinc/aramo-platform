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

// PR-14 (Track C) — personal bookmarks integration spec (real Postgres 17).
//
// Proves the directive's four rulings end-to-end plus the load-bearing
// invariant that a star must NEVER toggle is_hot:
//   1. A's bookmark is invisible to B (personal; the enriched `bookmarked`
//      field reflects ONLY the calling user).
//   2. Toggle is idempotent (SET semantics — repeated PUTs converge; a single
//      state row; the original bookmarked_at is preserved on re-bookmark).
//   3. The "My Bookmarks" filter returns ONLY the caller's own bookmarks.
//   4. Deleting a requisition CASCADES the state row (onDelete: Cascade).
//   5. Bookmarking never changes is_hot (team-wide, separate concept).
//
// Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');
const mig = (p: string): string =>
  resolve(ROOT, `libs/requisition/prisma/migrations/${p}/migration.sql`);

// The full requisition migration chain (Prisma SELECT * returns every column,
// so every column-adding migration must be applied) + entitlement init + the
// PR-14 user_requisition_state table (last). Order mirrors the proven
// ats-batch2 harness; the new state table depends only on Requisition (INIT).
const MIGRATIONS = [
  resolve(
    ROOT,
    'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  ),
  mig('20260602100000_init_requisition_model'),
  mig('20260603140100_add_import_batch_id_to_requisition'),
  mig('20260605123400_add_compensation_fields_to_requisition'),
  mig('20260611220000_job_module_requisition_fields'),
  mig('20260612120000_drop_legacy_requisition_comp'),
  mig('20260618120000_add_rate_type_subk_runmatch'),
  mig('20260721000000_add_publish_surface'),
  mig('20260731120000_add_requisition_lifecycle_event'),
  mig('20260801120000_add_version_to_requisition'),
  mig('20260802140000_add_onsite_days_to_requisition'),
  mig('20260802120000_lifecycle_previous_status_nullable'),
  mig('20260802160000_add_user_requisition_state'),
  // PR-15 — internal requisition_number (NOT NULL) + the allocator table; the
  // create path allocates from it, so a POST /requisitions 500s without it.
  mig('20260802180000_add_requisition_number'),
  // T1-d — RecruitingStatus supersession (LAST: alters the enum + lifecycle cols).
  mig('20260802200000_recruiting_status_supersession'),
];

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-requisition-bookmarks-spec';
const ALG = 'RS256';

const TENANT = '01900000-0000-7000-8000-0000000b0001';
const SITE = '33333333-3333-7333-8333-3333333333aa';
const COMPANY_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

// Two recruiters, both with read:all (so each sees every req in tenant — the
// bookmark test needs both users able to READ the same requisition) + create
// + delete (for the cascade test).
const USER_A = '00000000-0000-7000-8000-0000000000a1';
const USER_B = '00000000-0000-7000-8000-0000000000b1';
const SCOPES = [
  'requisition:read',
  'requisition:read:all',
  'requisition:create',
  'requisition:delete',
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-14 — personal bookmarks (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let setupClient: Client;

    let jwtA = '';
    let jwtB = '';

    async function signJwt(
      privateKey: SignKey,
      args: { sub: string },
    ): Promise<string> {
      return new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT,
        site_id: SITE,
        scopes: SCOPES,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);
    }

    async function createReq(jwt: string, title: string): Promise<string> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title, company_id: COMPANY_ID, site_id: SITE }),
        },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    }

    async function getReq(
      jwt: string,
      id: string,
    ): Promise<{ status: number; body: { bookmarked?: boolean; is_hot?: boolean } }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${id}?site_id=${SITE}`,
        { method: 'GET', headers: { Authorization: `Bearer ${jwt}` } },
      );
      return { status: res.status, body: (await res.json()) as never };
    }

    async function setBookmark(
      jwt: string,
      id: string,
      bookmarked: boolean,
    ): Promise<Response> {
      return fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${id}/bookmark?site_id=${SITE}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ bookmarked }),
        },
      );
    }

    async function listBookmarked(
      jwt: string,
    ): Promise<Array<{ id: string; bookmarked: boolean }>> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE}&bookmarked=true`,
        { method: 'GET', headers: { Authorization: `Bearer ${jwt}` } },
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { items: Array<{ id: string; bookmarked: boolean }> })
        .items;
    }

    async function stateRowCount(userId: string, reqId: string): Promise<number> {
      const r = await setupClient.query(
        `SELECT COUNT(*)::int AS n FROM requisition.user_requisition_state
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND requisition_id = $3::uuid`,
        [TENANT, userId, reqId],
      );
      return r.rows[0].n as number;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new Client({ connectionString: url });
      await setupClient.connect();

      for (const p of MIGRATIONS) {
        await setupClient.query(readFileSync(p, 'utf8'));
      }

      await ensureWriteFreezeTenant((s) => setupClient.query(s), TENANT);
      await setupClient.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'ats')
         ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT],
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

      jwtA = await signJwt(privateKey, { sub: USER_A });
      jwtB = await signJwt(privateKey, { sub: USER_B });

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
      );
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
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

    it("A's bookmark is invisible to B (personal, per-user)", async () => {
      const reqId = await createReq(jwtA, 'Bookmark isolation target');

      // A bookmarks it.
      const put = await setBookmark(jwtA, reqId, true);
      expect(put.status).toBe(200);
      expect(((await put.json()) as { bookmarked: boolean }).bookmarked).toBe(true);

      // A sees bookmarked:true on detail and in the list; B sees false on both.
      expect((await getReq(jwtA, reqId)).body.bookmarked).toBe(true);
      expect((await getReq(jwtB, reqId)).body.bookmarked).toBe(false);

      const inAList = (
        await (
          await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE}`, {
            headers: { Authorization: `Bearer ${jwtA}` },
          })
        ).json()
      ).items.find((r: { id: string }) => r.id === reqId);
      const inBList = (
        await (
          await fetch(`http://127.0.0.1:${port}/v1/requisitions?site_id=${SITE}`, {
            headers: { Authorization: `Bearer ${jwtB}` },
          })
        ).json()
      ).items.find((r: { id: string }) => r.id === reqId);
      expect(inAList.bookmarked).toBe(true);
      expect(inBList.bookmarked).toBe(false);
    });

    it('toggle is idempotent — repeated set converges to a single state row', async () => {
      const reqId = await createReq(jwtA, 'Idempotency target');

      // Bookmark twice.
      expect((await setBookmark(jwtA, reqId, true)).status).toBe(200);
      const firstAt = (
        await setupClient.query(
          `SELECT bookmarked_at FROM requisition.user_requisition_state
            WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND requisition_id=$3::uuid`,
          [TENANT, USER_A, reqId],
        )
      ).rows[0].bookmarked_at as Date;
      expect((await setBookmark(jwtA, reqId, true)).status).toBe(200);

      expect((await getReq(jwtA, reqId)).body.bookmarked).toBe(true);
      expect(await stateRowCount(USER_A, reqId)).toBe(1);
      // Idempotent: re-bookmarking preserves the original bookmarked_at.
      const secondAt = (
        await setupClient.query(
          `SELECT bookmarked_at FROM requisition.user_requisition_state
            WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND requisition_id=$3::uuid`,
          [TENANT, USER_A, reqId],
        )
      ).rows[0].bookmarked_at as Date;
      expect(new Date(secondAt).toISOString()).toBe(new Date(firstAt).toISOString());

      // Un-bookmark twice → converges to not-bookmarked, still one row.
      expect((await setBookmark(jwtA, reqId, false)).status).toBe(200);
      expect((await setBookmark(jwtA, reqId, false)).status).toBe(200);
      expect((await getReq(jwtA, reqId)).body.bookmarked).toBe(false);
      expect(await stateRowCount(USER_A, reqId)).toBe(1);
    });

    it('"My Bookmarks" filter returns ONLY the caller\'s own bookmarks', async () => {
      const r1 = await createReq(jwtA, 'Filter target 1 (A bookmarks)');
      const r2 = await createReq(jwtA, 'Filter target 2 (nobody bookmarks)');

      expect((await setBookmark(jwtA, r1, true)).status).toBe(200);

      const aList = await listBookmarked(jwtA);
      const aIds = aList.map((r) => r.id);
      expect(aIds).toContain(r1);
      expect(aIds).not.toContain(r2);
      expect(aList.every((r) => r.bookmarked === true)).toBe(true);

      // B has bookmarked nothing → B's My-Bookmarks excludes r1 (A's bookmark).
      const bIds = (await listBookmarked(jwtB)).map((r) => r.id);
      expect(bIds).not.toContain(r1);
    });

    it('deleting a requisition cascades the state row', async () => {
      const reqId = await createReq(jwtA, 'Cascade target');
      expect((await setBookmark(jwtA, reqId, true)).status).toBe(200);
      expect(await stateRowCount(USER_A, reqId)).toBe(1);

      const del = await fetch(
        `http://127.0.0.1:${port}/v1/requisitions/${reqId}?site_id=${SITE}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${jwtA}` } },
      );
      expect(del.status).toBe(204);

      // The FK onDelete: Cascade removed the state row.
      expect(await stateRowCount(USER_A, reqId)).toBe(0);
    });

    it('a bookmark NEVER toggles is_hot (separate team-wide concept)', async () => {
      const reqId = await createReq(jwtA, 'is_hot invariant target');
      expect((await getReq(jwtA, reqId)).body.is_hot).toBe(false);

      expect((await setBookmark(jwtA, reqId, true)).status).toBe(200);

      // is_hot is unchanged by the personal bookmark, for A and for B.
      expect((await getReq(jwtA, reqId)).body.is_hot).toBe(false);
      expect((await getReq(jwtB, reqId)).body.is_hot).toBe(false);
    });

    it('bookmarking a non-existent requisition → 404', async () => {
      const res = await setBookmark(
        jwtA,
        '00000000-0000-7000-8000-0000dead0001',
        true,
      );
      expect(res.status).toBe(404);
    });
  },
);
