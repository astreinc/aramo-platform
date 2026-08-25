import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { PolicyStore, PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';
import { RequisitionRepository } from '@aramo/requisition';

import { AppModule } from '../app.module.js';
import { REQUISITION_LIFECYCLE_PACKAGE } from '../policy/requisition-lifecycle.package.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';
import { placementCapacityMigrations } from './support/placement-capacity-migrations.js';

// ADR-0024 PR-7 — REQUISITION · SET_PRIORITY (is_hot). Real Postgres 17; skipped
// unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-set-priority-spec';
const ALG = 'RS256';
const TENANT = '01900000-0000-7000-8000-0000000000a7';
const SITE = '33333333-3333-7333-8333-3333333333a7';
const ACTOR = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa7';
const SYSTEM = '00000000-0000-0000-0000-000000000000';
const ALLOW_STATES = ['open', 'on_hold', 'submittals_closed', 'lead'];
const DENY_STATES = ['closed', 'canceled'];

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = [
  ...migrationsFor('entitlement'),
  ...migrationsFor('requisition'),
  ...migrationsFor('policy-store'),
  // Track 4 T4-B2 — requisition read DERIVES openings_available from the
  // placement-owned ACTIVE ContractAssignment population; placement schema required.
  ...placementCapacityMigrations(ROOT),
];

let uuidCounter = 0;
const uuid = (): string => `00000000-0000-7000-8000-${(++uuidCounter).toString(16).padStart(12, '0')}`;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-7 REQUISITION · SET_PRIORITY — is_hot gate (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let store: PolicyStore;
    let storePrisma: PolicyStorePrismaService;
    let signingKey: SignKey;
    let app: INestApplication;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    async function jwt(): Promise<string> {
      return new SignJWT({ sub: ACTOR, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: TENANT, site_id: SITE, scopes: ['requisition:create', 'requisition:edit', 'requisition:read', 'requisition:read:all'] })
        .setProtectedHeader({ alg: ALG }).setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('1h').sign(signingKey);
    }
    function baseUrl(): string {
      const a = app.getHttpServer().address();
      return `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
    }
    async function seedReq(status: string, isHot = false): Promise<string> {
      const id = uuid();
      // Allocate requisition_number from the same per-tenant sequence the app
      // uses (this tenant is ALSO written via POST /v1/requisitions and
      // createForImport), so seeded rows never collide with app-allocated ones.
      await db.query(`WITH seq AS (
          INSERT INTO requisition."RequisitionNumberSequence" (tenant_id, next_value)
          VALUES ($2::uuid, 1000)
          ON CONFLICT (tenant_id) DO UPDATE SET next_value = requisition."RequisitionNumberSequence".next_value + 1
          RETURNING next_value
        )
        INSERT INTO requisition."Requisition" (id, tenant_id, site_id, title, company_id, status, is_hot, requisition_number)
        SELECT $1,$2,$3,$4,$5,$6::"requisition"."RecruitingStatus",$7, (SELECT next_value FROM seq)`, [id, TENANT, SITE, `r-${status}`, uuid(), status, isHot]);
      return id;
    }
    async function patchHot(token: string, id: string, isHot: boolean): Promise<Response> {
      return fetch(`${baseUrl()}/v1/requisitions/${id}?site_id=${SITE}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_hot: isHot }),
      });
    }
    async function reqIsHot(id: string): Promise<boolean> {
      return (await db.query(`SELECT is_hot FROM requisition."Requisition" WHERE id=$1`, [id])).rows[0].is_hot;
    }
    async function setPriorityRecords(): Promise<Array<{ decision: string; policy_version: string }>> {
      return (await db.query(`SELECT decision, policy_version FROM policy_store."PolicyDecisionRecord" WHERE tenant_id=$1 AND action='SET_PRIORITY' ORDER BY occurred_at DESC`, [TENANT])).rows;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT);
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1,'ats') ON CONFLICT DO NOTHING`, [TENANT]);
      storePrisma = new PolicyStorePrismaService(url);
      await storePrisma.$connect();
      store = new PolicyStore(storePrisma);
      await store.publish({ tenant_id: TENANT, definition: REQUISITION_LIFECYCLE_PACKAGE, published_by: SYSTEM });

      const kp = await generateKeyPair(ALG);
      signingKey = kp.privateKey as SignKey;
      const pem = await exportSPKI(kp.publicKey as never);
      savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'] };
      process.env['DATABASE_URL'] = url; process.env['AUTH_AUDIENCE'] = AUDIENCE; process.env['AUTH_PUBLIC_KEY'] = pem;

      const mod: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
      await app.init();
      await app.listen(0);
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await storePrisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }, 60_000);

    it('is_hot=true is ALLOWED on active/on_hold/full/lead, DENIED on closed/canceled (POLICY_DENIED, no row-level priority set)', async () => {
      // L1-A — under create-governance the HTTP create route caps a human at
      // draft/open, so the SET_PRIORITY-on-create ALLOW/DENY matrix (which spans
      // operational statuses) is exercised at the repository floor via the
      // INTEGRATION establishment path (creation_mode INTEGRATION +
      // requisition:import:write). This is the SAME code the controller calls —
      // create() runs gateSetPriority with enforce=true, so the SET_PRIORITY
      // subject (ALLOW/DENY + provenance) is fully preserved; only the transport
      // moves off the now-capped HTTP route.
      const repo = app.get(RequisitionRepository, { strict: false });
      const SCOPES = ['requisition:create', 'requisition:import:write', 'requisition:edit', 'requisition:read', 'requisition:read:all'];
      for (const status of ALLOW_STATES) {
        const view = await repo.create({
          tenant_id: TENANT, entered_by_id: ACTOR,
          input: { title: `req-${status}`, company_id: uuid(), status, is_hot: true } as never,
          scopes: SCOPES, creation_mode: 'INTEGRATION', requestId: uuid(),
        });
        expect(view.is_hot, `set-true ${status}`).toBe(true);
      }
      for (const status of DENY_STATES) {
        await expect(
          repo.create({
            tenant_id: TENANT, entered_by_id: ACTOR,
            input: { title: `req-${status}`, company_id: uuid(), status, is_hot: true } as never,
            scopes: SCOPES, creation_mode: 'INTEGRATION', requestId: uuid(),
          }),
          `set-true ${status}`,
        ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      }
      // provenance recorded for every governed decision (ALLOW + DENY), naming v6.0.0.
      const recs = await setPriorityRecords();
      expect(recs.length).toBeGreaterThanOrEqual(6);
      expect(recs.every((r) => r.policy_version === '6.0.0')).toBe(true);
      expect(recs.filter((r) => r.decision === 'DENY').length).toBeGreaterThanOrEqual(2);
    });

    it('is_hot=FALSE on a closed requisition is ALLOWED (R3 — clearing is cleanup, not a governed set); the mutation happens', async () => {
      const id = await seedReq('closed', true); // a closed req carrying a stale HOT pill
      expect((await patchHot(await jwt(), id, false)).status).toBe(200);
      expect(await reqIsHot(id)).toBe(false); // cleared
    });

    it('is_hot=TRUE via PATCH on a closed requisition is DENIED (403), no mutation', async () => {
      const id = await seedReq('closed', false);
      expect((await patchHot(await jwt(), id, true)).status).toBe(403);
      expect(await reqIsHot(id)).toBe(false); // unchanged
    });

    it('IMPORT (createForImport) with is_hot on a terminal req SUCCEEDS (R2 exempt) and records SET_PRIORITY provenance', async () => {
      const repo = app.get(RequisitionRepository, { strict: false });
      const before = (await setPriorityRecords()).length;
      const view = await repo.createForImport({
        tenant_id: TENANT, entered_by_id: ACTOR, import_batch_id: uuid(),
        input: { title: 'imported-closed', company_id: uuid(), status: 'closed', is_hot: true } as never,
        // L1-A — INTEGRATION establishment authority = existing requisition:import:write.
        scopes: ['requisition:create', 'requisition:import:write'], requestId: uuid(),
      });
      expect(view.is_hot).toBe(true); // proceeded despite the terminal state (exempt)
      expect((await setPriorityRecords()).length).toBe(before + 1); // exemption is visible
    });

    it('reads are unaffected — a closed requisition with is_hot=true is still readable (the write gate never touches reads)', async () => {
      const id = await seedReq('closed', true);
      const res = await fetch(`${baseUrl()}/v1/requisitions/${id}?site_id=${SITE}`, { headers: { Authorization: `Bearer ${await jwt()}` } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { is_hot?: boolean }).is_hot).toBe(true);
    });

    it('§D17b — a SET_PRIORITY decision made under an earlier version still names it after v3.0.0 (re-read from DB)', async () => {
      const T = '01900000-0000-7000-8000-0000000000b7';
      await ensureWriteFreezeTenant((s) => db.query(s), T);
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1,'ats') ON CONFLICT DO NOTHING`, [T]);
      await store.publish({ tenant_id: T, definition: { ...REQUISITION_LIFECYCLE_PACKAGE, version: '1.0.0' }, published_by: SYSTEM, effective_from: new Date('2026-01-01T00:00:00Z') });
      // L1-A — establish the is_hot 'open' req via the INTEGRATION floor path
      // (import:write), the same create() that records the SET_PRIORITY decision.
      const repo = app.get(RequisitionRepository, { strict: false });
      const view = await repo.create({
        tenant_id: T, entered_by_id: ACTOR,
        input: { title: 'x', company_id: uuid(), status: 'open', is_hot: true } as never,
        scopes: ['requisition:create', 'requisition:import:write'], creation_mode: 'INTEGRATION', requestId: uuid(),
      });
      expect(view.is_hot).toBe(true);
      const first = (await db.query(`SELECT id, policy_version FROM policy_store."PolicyDecisionRecord" WHERE tenant_id=$1 AND action='SET_PRIORITY' ORDER BY occurred_at DESC LIMIT 1`, [T])).rows[0];
      expect(first.policy_version).toBe('1.0.0');
      await store.publish({ tenant_id: T, definition: { ...REQUISITION_LIFECYCLE_PACKAGE, version: '2.0.0' }, published_by: SYSTEM, effective_from: new Date('2026-06-01T00:00:00Z') });
      const reread = (await db.query(`SELECT policy_version FROM policy_store."PolicyDecisionRecord" WHERE id=$1`, [first.id])).rows[0];
      expect(reread.policy_version).toBe('1.0.0');
    });
  },
);
