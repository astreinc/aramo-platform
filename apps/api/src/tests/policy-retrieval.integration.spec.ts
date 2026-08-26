import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { PolicyStore } from '@aramo/policy-store';
import {
  REQUISITION_POLICY_STORE,
  RequisitionTransitionPolicyService,
  SetPriorityPolicyService,
} from '@aramo/requisition';

import { AppModule } from '../app.module.js';
import { REQUISITION_LIFECYCLE_PACKAGE } from '../policy/requisition-lifecycle.package.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';
import { publishLifecyclePackage } from './publish-lifecycle-package.js';

// ADR-0024 PR-4a — runtime retrieval properties: tenant isolation and §D17b
// version pinning on republish. Real Postgres 17; skipped unless
// ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-policy-retrieval-spec';
const ALG = 'RS256';
const TENANT_A = '01900000-0000-7000-8000-0000000000e1'; // gets a package
const TENANT_B = '01900000-0000-7000-8000-0000000000e2'; // never gets one
const ACTOR = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaae1';
const SITE = '33333333-3333-7333-8333-3333333333e1';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = [
  ...migrationsFor('entitlement'),
  ...migrationsFor('requisition'),
  ...migrationsFor('pipeline'),
  ...migrationsFor('policy-store'),
];

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `00000000-0000-7000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-4a policy retrieval — isolation + version pinning (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let dbUrl = '';
    let signingKey: SignKey;
    let app: INestApplication;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    async function signJwt(tenant: string): Promise<string> {
      return new SignJWT({ sub: ACTOR, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: tenant, site_id: SITE, scopes: ['pipeline:add'] })
        .setProtectedHeader({ alg: ALG }).setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('1h').sign(signingKey);
    }
    async function seedRequisition(tenant: string): Promise<string> {
      const id = uuid();
      await db.query(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, status, requisition_number) VALUES ($1,$2,$3,$4,'open', (SELECT COALESCE(MAX(rn.requisition_number),999)+1 FROM requisition."Requisition" rn WHERE rn.tenant_id = $2))`,
        [id, tenant, 'req', uuid()],
      );
      return id;
    }
    function baseUrl(): string {
      const a = app.getHttpServer().address();
      return `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
    }
    async function postAdd(tenant: string, requisitionId: string): Promise<Response> {
      return fetch(`${baseUrl()}/v1/pipelines?site_id=${SITE}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await signJwt(tenant)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ talent_record_id: uuid(), requisition_id: requisitionId, site_id: SITE }),
      });
    }
    async function latestRecord(tenant: string): Promise<{ id: string; policy_version: string; decision: string }> {
      return (await db.query(
        `SELECT id, policy_version, decision FROM policy_store."PolicyDecisionRecord" WHERE tenant_id=$1 ORDER BY occurred_at DESC LIMIT 1`, [tenant],
      )).rows[0];
    }
    async function recordById(id: string): Promise<{ policy_version: string }> {
      return (await db.query(`SELECT policy_version FROM policy_store."PolicyDecisionRecord" WHERE id=$1`, [id])).rows[0];
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      dbUrl = container.getConnectionUri();
      db = new Client({ connectionString: dbUrl });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      for (const t of [TENANT_A, TENANT_B]) {
        await ensureWriteFreezeTenant((s) => db.query(s), t);
        await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1,'ats') ON CONFLICT DO NOTHING`, [t]);
      }
      // TENANT_A gets the package; TENANT_B stays package-less (isolation).
      await publishLifecyclePackage(dbUrl, TENANT_A);

      const kp = await generateKeyPair(ALG);
      signingKey = kp.privateKey as SignKey;
      const pem = await exportSPKI(kp.publicKey as never);
      savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'] };
      process.env['DATABASE_URL'] = dbUrl;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = pem;

      const mod: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
      await app.init();
      await app.listen(0);
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }, 60_000);

    it('TENANT ISOLATION — A\'s package does not govern B: A allows, B fails closed', async () => {
      const reqA = await seedRequisition(TENANT_A);
      const reqB = await seedRequisition(TENANT_B);
      expect((await postAdd(TENANT_A, reqA)).status).toBe(201); // A has a package
      const resB = await postAdd(TENANT_B, reqB);
      expect(resB.status).toBe(403); // B has none → fail closed
      const bodyB = (await resB.json()) as { error?: { details?: Record<string, unknown> } };
      expect(bodyB.error?.details?.reason_code).toBe('NO_POLICY_PUBLISHED');
    });

    it('REPUBLISH / §D17b version pinning — a new version governs later decisions; the earlier record still names the OLD version (re-read from DB)', async () => {
      // A dedicated republish tenant with explicit, WELL-SEPARATED effective_from
      // windows so point-in-time selection cannot pass on insertion order.
      const T = '01900000-0000-7000-8000-0000000000e3';
      await ensureWriteFreezeTenant((s) => db.query(s), T);
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1,'ats') ON CONFLICT DO NOTHING`, [T]);

      // Publish through the APP's OWN PolicyStore — the same singleton the
      // add-talent consumer retrieves through — so a republish invalidates the
      // per-instance active-version cache. A separate PolicyStore instance would
      // write the new window to the DB but leave the running app holding a stale
      // open-window v1 (the cache is in-memory, not cross-instance). This mirrors
      // production: the process that decides is the one that publishes.
      const store = app.get(PolicyStore, { strict: false });

      // v1 active from 2026-01-01; v2 from 2026-06-01 (a five-month gap, both
      // in the past → v2 is the active version at "now").
      await store.publish({ tenant_id: T, definition: { ...REQUISITION_LIFECYCLE_PACKAGE, version: '1.0.0' }, published_by: SYSTEM, effective_from: new Date('2026-01-01T00:00:00Z') });

      const req1 = await seedRequisition(T);
      expect((await postAdd(T, req1)).status).toBe(201);
      const first = await latestRecord(T);
      expect(first.policy_version).toBe('1.0.0');

      // Republish a new version — takes effect for subsequent decisions.
      await store.publish({ tenant_id: T, definition: { ...REQUISITION_LIFECYCLE_PACKAGE, version: '2.0.0' }, published_by: SYSTEM, effective_from: new Date('2026-06-01T00:00:00Z') });

      const req2 = await seedRequisition(T);
      expect((await postAdd(T, req2)).status).toBe(201);
      const second = await latestRecord(T);
      expect(second.policy_version).toBe('2.0.0'); // new version governs now

      // §D17b — RE-READ the earlier record from the DB (not the remembered
      // value): it must STILL name v1. Stored immutability is the claim.
      const firstReReadAfterV2 = await recordById(first.id);
      expect(firstReReadAfterV2.policy_version).toBe('1.0.0');
    });

    // L1-F2 — the requisition policy gates resolve a DEDICATED string token, not
    // the bare `PolicyStore` class token. This is the wiring proof that both
    // consumers receive the REQUISITION_POLICY_STORE provider AND that the bare
    // class-token lookup the version-pinning test above reads through is NO LONGER
    // the requisition instance (deterministically pipeline's add-talent store).
    it('L1-F2 — both requisition policy gates @Inject the DEDICATED REQUISITION_POLICY_STORE, not the bare class token', () => {
      const dedicated = app.get(REQUISITION_POLICY_STORE, { strict: false });
      expect(dedicated).toBeInstanceOf(PolicyStore);

      const transition = app.get(RequisitionTransitionPolicyService, { strict: false });
      const setPriority = app.get(SetPriorityPolicyService, { strict: false });
      // Each consumer received the dedicated-token instance (the @Inject binding).
      expect((transition as unknown as { policyStore: PolicyStore }).policyStore).toBe(dedicated);
      expect((setPriority as unknown as { policyStore: PolicyStore }).policyStore).toBe(dedicated);

      // The bare class token (what the §D17b republish test resolves through)
      // is a DIFFERENT instance — requisition no longer competes for it, so the
      // non-strict lookup deterministically yields pipeline's add-talent store.
      const bare = app.get(PolicyStore, { strict: false });
      expect(bare).not.toBe(dedicated);
    });
  },
);
