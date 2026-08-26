import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair } from 'jose';
import { PolicyStore, PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';
import { CONNECTOR_SERVICE_ACCOUNT_ID, RequisitionLifecycleMappingRepository } from '@aramo/integration';

import { AppModule } from '../app.module.js';
import { REQUISITION_LIFECYCLE_PACKAGE } from '../policy/requisition-lifecycle.package.js';
import { ExternalLifecycleReconciler } from '../requisition-integration/external-lifecycle-reconciler.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';
import { placementCapacityMigrations } from './support/placement-capacity-migrations.js';

// L1-D1 (ADR-0030) — EXTERNAL LIFECYCLE AUTHORITY, end-to-end against real
// Postgres 17 through the full app, fed by a synthetic ExternalLifecycleEventInput
// pushed DIRECTLY into the orchestration seam (R-INGRESS — no live provider
// polling / webhook / adapter runtime / queue worker; all D2).
//
// Proves the complete governed domain path:
//   1. EXTERNAL_AUTHORITY: a mapped event EXECUTES the governed transition
//      (open -> on_hold), lifecycle event origin='integration', provenance recorded.
//   2. DUAL_CONTROL: the same mapped event RECORDS a pending row, does NOT execute.
//   3. ILLEGAL-FROM-STATE (policy DENY, REOPEN on canceled) -> reconciliation, no mutation.
//   4. UNMAPPABLE provider state -> reconciliation, no mutation.
//   5. CAS CONFLICT (concurrent internal edit) -> reconciliation, no lost update.
//   6. HONEST ORIGIN — the emitted event is origin='integration', never 'ui'.
//   7. HARD PROHIBITION (structural) — no connector/integration code writes
//      Requisition.status directly (this runs ALWAYS, not gated on the DB lane).
//   8. POLICY FAIL-CLOSED — an external command with no published package ->
//      DENY (reconciliation), never a bypass.

const ROOT = resolve(__dirname, '../../../..');

// -----------------------------------------------------------------------------
// Proof 7 — HARD PROHIBITION (structural). Runs ALWAYS (not DB-gated): no
// connector / integration / reconciler code may write Requisition.status
// directly. The ONLY external status-writing path is the governed command seam
// (executeExternalLifecycleCommand: gate -> CAS -> atomic event) in
// libs/requisition (which is EXCLUDED from this scan — it is the sanctioned path).
// -----------------------------------------------------------------------------
describe('L1-D1 proof 7 — HARD PROHIBITION: no direct Requisition.status write in connector/integration code', () => {
  function walkTs(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (name === 'generated' || name === 'node_modules') continue;
        out.push(...walkTs(p));
      } else if (name.endsWith('.ts')) {
        out.push(p);
      }
    }
    return out;
  }

  const scanned = [
    ...walkTs(resolve(ROOT, 'libs/integration/src')),
    ...walkTs(resolve(ROOT, 'apps/api/src/connector')),
    ...walkTs(resolve(ROOT, 'apps/api/src/requisition-integration')),
  ];

  it('scans a non-empty connector/integration surface', () => {
    expect(scanned.length).toBeGreaterThan(0);
  });

  it('no file writes the requisition table / status directly (no bypass of the governed seam)', () => {
    for (const file of scanned) {
      const content = readFileSync(file, 'utf8');
      // Prisma client direct write to the requisition MODEL.
      expect(content, `${file}: prisma requisition.update`).not.toMatch(/\.requisition\.update(Many)?\s*\(/i);
      expect(content, `${file}: prisma requisition.create`).not.toMatch(/\.requisition\.(create|upsert)\s*\(/i);
      // Raw SQL update of the requisition.Requisition table.
      expect(content, `${file}: raw UPDATE requisition.Requisition`).not.toMatch(
        /UPDATE\s+["'`]?requisition["'`]?\s*\.\s*["'`]?Requisition/i,
      );
      // The requisition write surface (RequisitionRepository.update) must NOT be
      // invoked from here — only the governed external-lifecycle command seam is.
      expect(content, `${file}: requisitions.update(`).not.toMatch(/requisitions\s*\.\s*update\s*\(/i);
    }
  });

  it('the reconciler reaches requisition state ONLY through executeExternalLifecycleCommand, as the connector service account', () => {
    const reconciler = readFileSync(
      resolve(ROOT, 'apps/api/src/requisition-integration/external-lifecycle-reconciler.ts'),
      'utf8',
    );
    expect(reconciler).toMatch(/executeExternalLifecycleCommand/);
    // The connector-actor-id authority binding: the reconciler always acts as
    // the connector service account, never a human.
    expect(reconciler).toMatch(/CONNECTOR_SERVICE_ACCOUNT_ID/);
    expect(reconciler).toMatch(/connectorPrincipalId/);
  });
});

// -----------------------------------------------------------------------------
// Proofs 1-6, 8 — the DB-backed domain path (real Postgres 17).
// -----------------------------------------------------------------------------
const MIGRATIONS = [
  ...migrationsFor('entitlement'),
  ...migrationsFor('requisition'),
  ...migrationsFor('policy-store'),
  ...migrationsFor('integration'),
  ...placementCapacityMigrations(ROOT),
];

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

const TENANT = '01900000-0000-7000-8000-0000000000e1'; // external_authority tenant (package published)
const TENANT_NOPOLICY = '01900000-0000-7000-8000-0000000000e2'; // fail-closed tenant (NO package)
const SYSTEM = '00000000-0000-0000-0000-000000000000';

let seq = 0;
const uuid = (): string => `00000000-0000-7000-8000-${(++seq).toString(16).padStart(12, '0')}`;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L1-D1 — external lifecycle authority (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let storePrisma: PolicyStorePrismaService;
    let app: INestApplication;
    let reconciler: ExternalLifecycleReconciler;
    let mappings: RequisitionLifecycleMappingRepository;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    // Seed a requisition at version 0 in the given tenant, using the same
    // per-tenant number sequence the app uses so seeds never collide.
    async function seedReq(tenant: string, status: string): Promise<string> {
      const id = uuid();
      await db.query(
        `WITH seq AS (
           INSERT INTO requisition."RequisitionNumberSequence" (tenant_id, next_value)
           VALUES ($2::uuid, 1000)
           ON CONFLICT (tenant_id) DO UPDATE SET next_value = requisition."RequisitionNumberSequence".next_value + 1
           RETURNING next_value
         )
         INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, status, requisition_number)
         SELECT $1,$2,$3,$4,$5::"requisition"."RecruitingStatus",(SELECT next_value FROM seq)`,
        [id, tenant, `r-${status}`, uuid(), status],
      );
      return id;
    }

    async function seedConnection(tenant: string): Promise<string> {
      const id = uuid();
      await db.query(
        `INSERT INTO integration."IntegrationConnection" (id, tenant_id, provider_key, status, updated_at)
         VALUES ($1,$2,'fieldglass','active', now())`,
        [id, tenant],
      );
      return id;
    }

    async function rowOf(id: string): Promise<{ status: string; version: number; title: string }> {
      return (await db.query(`SELECT status, version, title FROM requisition."Requisition" WHERE id=$1`, [id])).rows[0];
    }
    async function eventsOf(id: string): Promise<
      Array<{ previous_status: string | null; next_status: string; origin: string; actor_id: string; policy_decision_id: string | null; correlation_id: string }>
    > {
      return (
        await db.query(
          `SELECT previous_status, next_status, origin, actor_id, policy_decision_id, correlation_id
             FROM requisition."RequisitionLifecycleEvent" WHERE requisition_id=$1 ORDER BY occurred_at ASC`,
          [id],
        )
      ).rows;
    }
    async function provenanceOf(connectionId: string, eventId: string): Promise<Record<string, unknown> | undefined> {
      return (
        await db.query(
          `SELECT * FROM integration."RequisitionExternalTransitionProvenance" WHERE connection_id=$1 AND external_event_id=$2`,
          [connectionId, eventId],
        )
      ).rows[0];
    }
    async function reconOf(connectionId: string, eventId: string): Promise<Record<string, unknown> | undefined> {
      return (
        await db.query(
          `SELECT * FROM integration."RequisitionExternalReconciliation" WHERE connection_id=$1 AND external_event_id=$2`,
          [connectionId, eventId],
        )
      ).rows[0];
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      for (const t of [TENANT, TENANT_NOPOLICY]) {
        await ensureWriteFreezeTenant((s) => db.query(s), t);
        await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1,'ats') ON CONFLICT DO NOTHING`, [t]);
      }
      storePrisma = new PolicyStorePrismaService(url);
      await storePrisma.$connect();
      const store = new PolicyStore(storePrisma);
      // Publish the governed lifecycle package for the external_authority tenant
      // ONLY. TENANT_NOPOLICY is deliberately left with NO package (proof 8).
      await store.publish({ tenant_id: TENANT, definition: REQUISITION_LIFECYCLE_PACKAGE, published_by: SYSTEM });

      // AppModule boot requires a valid AUTH public key (guards init at
      // construction). This seam is not HTTP — no JWT is minted — but the env
      // must be present for the app to build.
      const kp = await generateKeyPair('RS256');
      const pem = await exportSPKI(kp.publicKey as never);
      savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'] };
      process.env['DATABASE_URL'] = url; process.env['AUTH_AUDIENCE'] = 'aramo-l1d1-spec'; process.env['AUTH_PUBLIC_KEY'] = pem;

      const mod: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      await app.init();
      reconciler = app.get(ExternalLifecycleReconciler);
      mappings = app.get(RequisitionLifecycleMappingRepository);
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await storePrisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }, 60_000);

    it('proof 1 — EXTERNAL_AUTHORITY: a mapped event EXECUTES open -> on_hold; event origin=integration; provenance recorded', async () => {
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      const eventId = uuid();

      // BEFORE (non-vacuous).
      expect((await rowOf(reqId)).status).toBe('open');

      const result = await reconciler.ingest({
        tenant_id: TENANT, connection_id: connId, provider_key: 'fieldglass',
        external_event_id: eventId, external_req_id: 'VMS-1', requisition_id: reqId,
        external_event_at: '2026-08-26T10:00:00.000Z', raw_provider_status: 'on_hold',
      });
      expect(result.outcome).toBe('EXECUTED');

      // AFTER — the governed transition committed.
      const after = await rowOf(reqId);
      expect(after.status).toBe('on_hold');
      expect(after.version).toBe(1);

      const events = await eventsOf(reqId);
      expect(events).toHaveLength(1);
      expect(events[0]?.previous_status).toBe('open');
      expect(events[0]?.next_status).toBe('on_hold');
      expect(events[0]?.origin).toBe('integration'); // honest origin
      expect(events[0]?.actor_id).toBe(CONNECTOR_SERVICE_ACCOUNT_ID); // connector service account
      expect(events[0]?.policy_decision_id).not.toBeNull();
      // The seam threads the external_event_id as the audit correlation id.
      expect(events[0]?.correlation_id).toBe(eventId);
      expect(result).toMatchObject({ outcome: 'EXECUTED', next_status: 'on_hold' });
      const emittedEventId = result.outcome === 'EXECUTED' ? result.lifecycle_event_id : null;

      // Structured external provenance links the transition to the external event.
      const prov = await provenanceOf(connId, eventId);
      expect(prov).toBeDefined();
      expect(prov?.['raw_provider_status']).toBe('on_hold');
      expect(prov?.['normalized_status']).toBe('on_hold');
      expect(prov?.['mapped_action']).toBe('PUT_ON_HOLD');
      expect(prov?.['mapping_version']).toBe(1);
      expect(prov?.['lifecycle_event_id']).toBe(emittedEventId);
      expect(prov?.['policy_decision_id']).toBe(events[0]?.policy_decision_id);

      // No reconciliation row on the happy path.
      expect(await reconOf(connId, eventId)).toBeUndefined();
    });

    it('proof 2 — DUAL_CONTROL: the same mapped event RECORDS a pending row and does NOT execute (before=open, after=open)', async () => {
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'dual_control' });
      const eventId = uuid();

      expect((await rowOf(reqId)).status).toBe('open'); // BEFORE

      const result = await reconciler.ingest({
        tenant_id: TENANT, connection_id: connId, provider_key: 'fieldglass',
        external_event_id: eventId, requisition_id: reqId,
        external_event_at: '2026-08-26T10:05:00.000Z', raw_provider_status: 'on_hold',
      });
      expect(result).toEqual({ outcome: 'RECONCILED', reason: 'DUAL_CONTROL_PENDING' });

      const after = await rowOf(reqId);
      expect(after.status).toBe('open'); // AFTER — NOT executed
      expect(after.version).toBe(0); // untouched
      expect(await eventsOf(reqId)).toHaveLength(0); // no lifecycle event
      const recon = await reconOf(connId, eventId);
      expect(recon?.['status']).toBe('pending');
      expect(recon?.['failure_reason']).toBe('DUAL_CONTROL_PENDING');
      expect(recon?.['mapped_action']).toBe('PUT_ON_HOLD');
    });

    it('proof 3 — ILLEGAL-FROM-STATE (REOPEN on canceled): policy DENY -> reconciliation, no mutation (before=canceled, after=canceled)', async () => {
      const reqId = await seedReq(TENANT, 'canceled');
      const connId = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'reopened', mapped_action: 'REOPEN', authority_mode: 'external_authority' });
      const eventId = uuid();

      expect((await rowOf(reqId)).status).toBe('canceled'); // BEFORE

      const result = await reconciler.ingest({
        tenant_id: TENANT, connection_id: connId, provider_key: 'fieldglass',
        external_event_id: eventId, requisition_id: reqId,
        external_event_at: '2026-08-26T10:10:00.000Z', raw_provider_status: 'reopened',
      });
      expect(result).toEqual({ outcome: 'RECONCILED', reason: 'POLICY_DENIED' });

      expect((await rowOf(reqId)).status).toBe('canceled'); // AFTER — unchanged
      expect(await eventsOf(reqId)).toHaveLength(0);
      const recon = await reconOf(connId, eventId);
      expect(recon?.['status']).toBe('pending');
      expect(recon?.['failure_reason']).toBe('POLICY_DENIED');
      expect(recon?.['current_aramo_status']).toBe('canceled');
    });

    it('proof 4 — UNMAPPABLE provider state (no mapping) -> reconciliation, no mutation', async () => {
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT); // NO mapping seeded
      const eventId = uuid();

      expect((await rowOf(reqId)).status).toBe('open'); // BEFORE

      const result = await reconciler.ingest({
        tenant_id: TENANT, connection_id: connId, provider_key: 'fieldglass',
        external_event_id: eventId, requisition_id: reqId,
        external_event_at: '2026-08-26T10:15:00.000Z', raw_provider_status: 'quantum_superposition',
      });
      expect(result).toEqual({ outcome: 'RECONCILED', reason: 'UNMAPPABLE_PROVIDER_STATE' });

      expect((await rowOf(reqId)).status).toBe('open'); // AFTER — unchanged
      expect(await eventsOf(reqId)).toHaveLength(0);
      const recon = await reconOf(connId, eventId);
      expect(recon?.['status']).toBe('pending');
      expect(recon?.['failure_reason']).toBe('UNMAPPABLE_PROVIDER_STATE');
      expect(recon?.['mapped_action']).toBeNull();
    });

    it('proof 5 — CAS CONFLICT: a concurrent internal edit bumped version -> reconciliation, NO lost update', async () => {
      const reqId = await seedReq(TENANT, 'open'); // version 0
      const connId = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      const eventId = uuid();

      // A concurrent internal edit lands FIRST, bumping version 0 -> 1 and setting
      // an observable field. The external command carries the stale version 0.
      await db.query(`UPDATE requisition."Requisition" SET version=1, title='internal-edit-won' WHERE id=$1`, [reqId]);

      const result = await reconciler.ingest({
        tenant_id: TENANT, connection_id: connId, provider_key: 'fieldglass',
        external_event_id: eventId, requisition_id: reqId,
        external_event_at: '2026-08-26T10:20:00.000Z', raw_provider_status: 'on_hold',
        expected_version: 0, // stale
      });
      expect(result).toEqual({ outcome: 'RECONCILED', reason: 'CAS_CONFLICT' });

      // The internal edit SURVIVES — no lost update; the external PUT_ON_HOLD did NOT apply.
      const after = await rowOf(reqId);
      expect(after.status).toBe('open');
      expect(after.version).toBe(1);
      expect(after.title).toBe('internal-edit-won');
      expect(await eventsOf(reqId)).toHaveLength(0);
      expect((await reconOf(connId, eventId))?.['failure_reason']).toBe('CAS_CONFLICT');
    });

    it('proof 6 — HONEST ORIGIN: the emitted lifecycle event is origin=integration, never ui', async () => {
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'closed', mapped_action: 'CLOSE', authority_mode: 'external_authority' });
      const eventId = uuid();

      const result = await reconciler.ingest({
        tenant_id: TENANT, connection_id: connId, provider_key: 'fieldglass',
        external_event_id: eventId, requisition_id: reqId,
        external_event_at: '2026-08-26T10:25:00.000Z', raw_provider_status: 'closed',
      });
      expect(result.outcome).toBe('EXECUTED');

      const events = await eventsOf(reqId);
      expect(events).toHaveLength(1);
      expect(events[0]?.origin).toBe('integration');
      // Never 'ui' for an external-authority transition.
      const uiEvents = (await db.query(`SELECT count(*)::int AS c FROM requisition."RequisitionLifecycleEvent" WHERE requisition_id=$1 AND origin='ui'`, [reqId])).rows[0].c;
      expect(uiEvents).toBe(0);
    });

    it('proof 8 — POLICY FAIL-CLOSED: an external command with no published package -> DENY (reconciliation), never a bypass', async () => {
      const reqId = await seedReq(TENANT_NOPOLICY, 'open');
      const connId = await seedConnection(TENANT_NOPOLICY);
      await mappings.upsertMapping({ tenant_id: TENANT_NOPOLICY, connection_id: connId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      const eventId = uuid();

      expect((await rowOf(reqId)).status).toBe('open'); // BEFORE

      const result = await reconciler.ingest({
        tenant_id: TENANT_NOPOLICY, connection_id: connId, provider_key: 'fieldglass',
        external_event_id: eventId, requisition_id: reqId,
        external_event_at: '2026-08-26T10:30:00.000Z', raw_provider_status: 'on_hold',
      });
      expect(result).toEqual({ outcome: 'RECONCILED', reason: 'POLICY_DENIED' });

      expect((await rowOf(reqId)).status).toBe('open'); // AFTER — no bypass
      expect(await eventsOf(reqId)).toHaveLength(0);
      expect(await provenanceOf(connId, eventId)).toBeUndefined();
      expect((await reconOf(connId, eventId))?.['failure_reason']).toBe('POLICY_DENIED');
    });
  },
);
