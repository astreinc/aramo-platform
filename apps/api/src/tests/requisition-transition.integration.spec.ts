import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { PolicyStore, PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';

import { AppModule } from '../app.module.js';
import { REQUISITION_LIFECYCLE_PACKAGE } from '../policy/requisition-lifecycle.package.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// Track 1 T1-e — GOVERNED REQUISITION TRANSITIONS, end-to-end against real
// Postgres 17 through the full HTTP app. Skipped unless ARAMO_RUN_INTEGRATION=1.
//
// Proves, over the wire, every §6 behaviour a unit/DATA test cannot:
//   · each governed transition (CLOSE/REOPEN/PUT_ON_HOLD/CANCEL) evaluates the
//     policy, records provenance, writes ONE lifecycle event carrying that
//     decision's id, and increments version;
//   · a stale version → 409, NO mutation, NO event, NO decision record (R4);
//   · a status-changing PATCH without version → 400 (§2.4);
//   · a transition INTO a gated status → 422 server-side (§2.3 / R9);
//   · a DENY transition → 403 POLICY_DENIED, no bypass (R8);
//   · lead → open succeeds (R5);
//   · an UNGOVERNED status change (submittals_closed) stays an ordinary edit —
//     event with a NULL policy_decision_id, no decision record (R8 boundary);
//   · §D17b — a decision made under v4.0.0 still names it after v5.0.0 publishes.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-transition-spec';
const ALG = 'RS256';
const TENANT = '01900000-0000-7000-8000-0000000000c1';
const SITE = '33333333-3333-7333-8333-3333333333c1';
const ACTOR = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaac1';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = [
  ...migrationsFor('entitlement'),
  ...migrationsFor('requisition'),
  ...migrationsFor('policy-store'),
];

let uuidCounter = 0;
const uuid = (): string => `00000000-0000-7000-8000-${(++uuidCounter).toString(16).padStart(12, '0')}`;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T1-e — governed requisition transitions (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let store: PolicyStore;
    let storePrisma: PolicyStorePrismaService;
    let signingKey: SignKey;
    let app: INestApplication;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    async function jwt(scopes: string[] = ['requisition:create', 'requisition:edit', 'requisition:read', 'requisition:read:all']): Promise<string> {
      return new SignJWT({ sub: ACTOR, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: TENANT, site_id: SITE, scopes })
        .setProtectedHeader({ alg: ALG }).setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('1h').sign(signingKey);
    }
    function baseUrl(): string {
      const a = app.getHttpServer().address();
      return `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
    }
    // Seed a requisition row at version 0 with a chosen status, via the same
    // per-tenant number sequence the app uses so seeds never collide.
    async function seedReq(status: string): Promise<string> {
      const id = uuid();
      await db.query(
        `WITH seq AS (
           INSERT INTO requisition."RequisitionNumberSequence" (tenant_id, next_value)
           VALUES ($2::uuid, 1000)
           ON CONFLICT (tenant_id) DO UPDATE SET next_value = requisition."RequisitionNumberSequence".next_value + 1
           RETURNING next_value
         )
         INSERT INTO requisition."Requisition" (id, tenant_id, site_id, title, company_id, status, requisition_number)
         SELECT $1,$2,$3,$4,$5,$6::"requisition"."RecruitingStatus",(SELECT next_value FROM seq)`,
        [id, TENANT, SITE, `r-${status}`, uuid(), status],
      );
      return id;
    }
    // The x-request-id header becomes request.requestId (RequestIdMiddleware),
    // which the domain threads as the lifecycle event + decision record
    // correlation_id — so a caller-supplied UUID lets us correlate BOTH to this
    // exact PATCH (decision records carry no requisition_id column).
    async function patchStatus(token: string, id: string, body: Record<string, unknown>, corr?: string): Promise<Response> {
      return fetch(`${baseUrl()}/v1/requisitions/${id}?site_id=${SITE}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(corr === undefined ? {} : { 'x-request-id': corr }),
        },
        body: JSON.stringify(body),
      });
    }
    async function rowOf(id: string): Promise<{ status: string; version: number }> {
      return (await db.query(`SELECT status, version FROM requisition."Requisition" WHERE id=$1`, [id])).rows[0];
    }
    async function eventsOf(id: string): Promise<Array<{ previous_status: string | null; next_status: string; policy_decision_id: string | null }>> {
      return (await db.query(`SELECT previous_status, next_status, policy_decision_id FROM requisition."RequisitionLifecycleEvent" WHERE requisition_id=$1 ORDER BY occurred_at ASC`, [id])).rows;
    }
    async function decisionsByCorr(corr: string, action: string): Promise<Array<{ id: string; decision: string; policy_version: string }>> {
      return (await db.query(`SELECT id, decision, policy_version FROM policy_store."PolicyDecisionRecord" WHERE tenant_id=$1 AND action=$2 AND correlation_id=$3 ORDER BY occurred_at ASC`, [TENANT, action, corr])).rows;
    }
    async function decisionCountByCorr(corr: string): Promise<number> {
      return (await db.query(`SELECT count(*)::int AS c FROM policy_store."PolicyDecisionRecord" WHERE correlation_id=$1`, [corr])).rows[0].c;
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

    it('CLOSE (open → closed) — policy evaluated, provenance recorded, ONE event carrying the decision id, version incremented', async () => {
      const token = await jwt();
      const id = await seedReq('open');
      const corr = uuid();
      const res = await patchStatus(token, id, { status: 'closed', version: 0 }, corr);
      expect(res.status).toBe(200);
      const view = (await res.json()) as { status: string; version: number };
      expect(view.status).toBe('closed');
      expect(view.version).toBe(1); // §2.1 the token is surfaced + incremented

      const events = await eventsOf(id);
      expect(events).toHaveLength(1);
      expect(events[0]?.previous_status).toBe('open');
      expect(events[0]?.next_status).toBe('closed');

      const decisions = await decisionsByCorr(corr, 'CLOSE');
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.decision).toBe('ALLOW');
      expect(decisions[0]?.policy_version).toBe('5.0.0');
      // §2.2 — the lifecycle event names the very decision the engine recorded.
      expect(events[0]?.policy_decision_id).toBe(decisions[0]?.id);
    });

    it('REOPEN, PUT_ON_HOLD, CANCEL each ALLOW from open and increment version', async () => {
      const token = await jwt();
      for (const [status, expectAction] of [['on_hold', 'PUT_ON_HOLD'], ['canceled', 'CANCEL']] as const) {
        const id = await seedReq('open');
        const corr = uuid();
        const res = await patchStatus(token, id, { status, version: 0 }, corr);
        expect(res.status, `open → ${status}`).toBe(200);
        expect((await rowOf(id)).version).toBe(1);
        expect((await decisionsByCorr(corr, expectAction))[0]?.decision).toBe('ALLOW');
      }
      // REOPEN from a closed requisition.
      const closed = await seedReq('closed');
      const corr = uuid();
      expect((await patchStatus(token, closed, { status: 'open', version: 0 }, corr)).status).toBe(200);
      expect((await decisionsByCorr(corr, 'REOPEN'))[0]?.decision).toBe('ALLOW');
    });

    it('R5 — lead → open (REOPEN from lead) is an ordinary allowed recruiter action', async () => {
      const token = await jwt();
      const id = await seedReq('lead');
      const res = await patchStatus(token, id, { status: 'open', version: 0 });
      expect(res.status).toBe(200);
      expect((await rowOf(id)).status).toBe('open');
    });

    it('§2.3 / R9 — a transition INTO a gated status is refused server-side (422 REQUISITION_STATUS_GATED), no mutation', async () => {
      const token = await jwt();
      const id = await seedReq('open');
      const res = await patchStatus(token, id, { status: 'draft', version: 0 });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error?: { code?: string; details?: { status?: string } } };
      expect(body.error?.code).toBe('REQUISITION_STATUS_GATED');
      expect(body.error?.details?.status).toBe('draft');
      // Unchanged, and no governed decision was recorded.
      expect((await rowOf(id)).status).toBe('open');
      expect(await eventsOf(id)).toHaveLength(0);
    });

    it('§2.4 — a status-changing PATCH WITHOUT version is refused (400 VALIDATION_ERROR); no mutation', async () => {
      const token = await jwt();
      const id = await seedReq('open');
      const res = await patchStatus(token, id, { status: 'closed' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string; details?: { reason?: string } } };
      expect(body.error?.code).toBe('VALIDATION_ERROR');
      expect(body.error?.details?.reason).toBe('version_required_for_status_change');
      expect((await rowOf(id)).status).toBe('open');
      expect(await eventsOf(id)).toHaveLength(0);
    });

    it('§2.4 posture — a NON-status PATCH without version still succeeds (T1-b additive)', async () => {
      const token = await jwt();
      const id = await seedReq('open');
      const res = await patchStatus(token, id, { title: 'Retitled, no version' });
      expect(res.status).toBe(200);
      expect((await rowOf(id)).version).toBe(1); // unguarded but still increments
      expect(await eventsOf(id)).toHaveLength(0); // no status change → no event
    });

    it('R8 — a DENY transition (CLOSE from canceled) is refused (403 POLICY_DENIED); no bypass, no event, DENY recorded', async () => {
      const token = await jwt();
      const id = await seedReq('canceled');
      const corr = uuid();
      const res = await patchStatus(token, id, { status: 'closed', version: 0 }, corr);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('POLICY_DENIED');
      // The status could NOT be reached by picking a different path — unchanged.
      expect((await rowOf(id)).status).toBe('canceled');
      expect(await eventsOf(id)).toHaveLength(0);
      const denied = await decisionsByCorr(corr, 'CLOSE');
      expect(denied).toHaveLength(1);
      expect(denied[0]?.decision).toBe('DENY');
    });

    it('R4 — a stale-version transition fails the CAS: 409, NO mutation, NO event, NO decision record', async () => {
      const token = await jwt();
      const id = await seedReq('open'); // version 0
      const corr = uuid();
      const res = await patchStatus(token, id, { status: 'closed', version: 99 }, corr);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('REQUISITION_VERSION_CONFLICT');
      // The transition never happened — the tx aborted before any write.
      const row = await rowOf(id);
      expect(row.status).toBe('open');
      expect(row.version).toBe(0);
      expect(await eventsOf(id)).toHaveLength(0);
      expect(await decisionsByCorr(corr, 'CLOSE')).toHaveLength(0);
    });

    it('R8 boundary — an UNGOVERNED status change (submittals_closed) stays an ordinary edit: event with NULL policy_decision_id, no decision record', async () => {
      const token = await jwt();
      const id = await seedReq('open');
      const corr = uuid();
      const res = await patchStatus(token, id, { status: 'submittals_closed', version: 0 }, corr);
      expect(res.status).toBe(200);
      const events = await eventsOf(id);
      expect(events).toHaveLength(1);
      expect(events[0]?.next_status).toBe('submittals_closed');
      expect(events[0]?.policy_decision_id).toBeNull(); // ungoverned → no decision
      // No governed action ran for this target — zero decision records.
      expect(await decisionCountByCorr(corr)).toBe(0);
    });

    it('§D17b — a transition decision made under v4.0.0 still names it after v5.0.0 is published (re-read from the DB)', async () => {
      const T = '01900000-0000-7000-8000-0000000000d9';
      await ensureWriteFreezeTenant((s) => db.query(s), T);
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1,'ats') ON CONFLICT DO NOTHING`, [T]);
      // Publish a v4.0.0 window first, make a CLOSE decision under it.
      await store.publish({ tenant_id: T, definition: { ...REQUISITION_LIFECYCLE_PACKAGE, version: '4.0.0' }, published_by: SYSTEM, effective_from: new Date('2026-01-01T00:00:00Z') });
      const token = await new SignJWT({ sub: ACTOR, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: T, site_id: SITE, scopes: ['requisition:edit'] })
        .setProtectedHeader({ alg: ALG }).setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('1h').sign(signingKey);
      const id = uuid();
      await db.query(`INSERT INTO requisition."Requisition" (id, tenant_id, site_id, title, company_id, status, requisition_number) VALUES ($1,$2,$3,'r',$4,'open',(SELECT COALESCE(MAX(rn.requisition_number),999)+1 FROM requisition."Requisition" rn WHERE rn.tenant_id=$2))`, [id, T, SITE, uuid()]);
      expect((await fetch(`${baseUrl()}/v1/requisitions/${id}?site_id=${SITE}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'closed', version: 0 }) })).status).toBe(200);
      const first = (await db.query(`SELECT id, policy_version FROM policy_store."PolicyDecisionRecord" WHERE tenant_id=$1 AND action='CLOSE' ORDER BY occurred_at DESC LIMIT 1`, [T])).rows[0];
      expect(first.policy_version).toBe('4.0.0');
      // Publish v5.0.0 (later window); the earlier record must STILL name 4.0.0.
      await store.publish({ tenant_id: T, definition: REQUISITION_LIFECYCLE_PACKAGE, published_by: SYSTEM, effective_from: new Date('2026-06-01T00:00:00Z') });
      const reread = (await db.query(`SELECT policy_version FROM policy_store."PolicyDecisionRecord" WHERE id=$1`, [first.id])).rows[0];
      expect(reread.policy_version).toBe('4.0.0');
    });
  },
);
