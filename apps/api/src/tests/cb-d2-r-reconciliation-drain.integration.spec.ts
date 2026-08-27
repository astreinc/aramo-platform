import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportSPKI, generateKeyPair } from 'jose';
import { PolicyStore, PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';
import { RequisitionRepository } from '@aramo/requisition';
import {
  RECONCILIATION_DISPOSITION,
  RECONCILIATION_FAILURE_REASON,
  RECONCILIATION_FAILURE_REASONS,
  classifyReconciliation,
  ExternalRequisitionIdentityRepository,
  RequisitionLifecycleMappingRepository,
  type ReconciliationClass,
} from '@aramo/integration';

import { AppModule } from '../app.module.js';
import { REQUISITION_LIFECYCLE_PACKAGE } from '../policy/requisition-lifecycle.package.js';
import { RequisitionReconciliationDrainService } from '../requisition-integration/reconciliation-drain.service.js';
import { RequisitionIdentityEstablishmentService } from '../requisition-integration/requisition-identity-establishment.service.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';
import { placementCapacityMigrations } from './support/placement-capacity-migrations.js';

// CB-D2-R (ADR-0030) — the reconciliation-DRAINING worker, end-to-end against real
// Postgres 17 through the full app, driven by the drainBatch seam (the
// talent-reconcile test-seam precedent — prove the drain without a live Redis
// worker). It drains the pending RequisitionExternalReconciliation rows A1 + FG
// only WRITE today. Proves the LOCKED 4-way taxonomy + governing invariant:
//   1. RE_EVALUABLE (mapping): UNMAPPABLE row → seed mapping → drain → resolved +
//      governed lifecycle event (BEFORE pending + EXACT after; gate→CAS→audit).
//   2. RE_EVALUABLE (identity): REQUISITION_NOT_FOUND → establish identity → drain
//      → resolved + transition; a null external_req_id → parked (never guessed).
//   3. CAS_CONFLICT: a stale reload → the seam refuses again → bumped/backed-off,
//      NOT blind-retried; at the cap → parked; the interfering edit survives.
//   4. SUPERSEDED (ORDERING_STALE): drain marks resolved with NO Requisition mutation.
//   5. INTERVENTION (ILLEGAL/POLICY/AMBIGUOUS): after bounded attempts, parked;
//      NEVER auto-executes a transition.
//   6. DUAL_CONTROL excluded: never claimed/executed by the drain.
//   7. CLAIM concurrency: two concurrent drains → each row processed once (lease);
//      a parked/poison row is not re-picked.
//   8. TAXONOMY exhaustiveness (ALWAYS): every writer-emitted reason is in the
//      const + classified.
//   9. HARD PROHIBITION (ALWAYS, structural): the worker reaches Requisition state
//      ONLY through executeExternalLifecycleCommand — no direct status write.

const ROOT = resolve(__dirname, '../../../..');

// -----------------------------------------------------------------------------
// Proof 8 — TAXONOMY exhaustiveness (ALWAYS; not DB-gated). Every reason a writer
// can emit is in the const AND classified — no unhandled token silently mis-drained.
// -----------------------------------------------------------------------------
describe('CB-D2-R proof 8 — taxonomy exhaustiveness', () => {
  it('the const enumerates exactly the 8 writer-emitted tokens', () => {
    expect([...RECONCILIATION_FAILURE_REASONS].sort()).toEqual(
      [
        'CAS_CONFLICT',
        'DUAL_CONTROL_PENDING',
        'ILLEGAL_FROM_STATE',
        'ORDERING_AMBIGUOUS',
        'ORDERING_STALE',
        'POLICY_DENIED',
        'REQUISITION_NOT_FOUND',
        'UNMAPPABLE_PROVIDER_STATE',
      ].sort(),
    );
  });

  it('every token classifies into exactly one LOCKED 4-way class', () => {
    const byClass: Record<ReconciliationClass, string[]> = {
      RE_EVALUABLE: [],
      SUPERSEDED: [],
      INTERVENTION: [],
      EXCLUDED: [],
    };
    for (const reason of RECONCILIATION_FAILURE_REASONS) {
      byClass[classifyReconciliation(reason)].push(reason);
    }
    expect(byClass.RE_EVALUABLE.sort()).toEqual(
      ['CAS_CONFLICT', 'REQUISITION_NOT_FOUND', 'UNMAPPABLE_PROVIDER_STATE'].sort(),
    );
    expect(byClass.SUPERSEDED).toEqual(['ORDERING_STALE']);
    expect(byClass.INTERVENTION.sort()).toEqual(
      ['ILLEGAL_FROM_STATE', 'ORDERING_AMBIGUOUS', 'POLICY_DENIED'].sort(),
    );
    expect(byClass.EXCLUDED).toEqual(['DUAL_CONTROL_PENDING']);
  });

  it('the two writers emit ONLY tokens present in the const (no bare-literal drift)', () => {
    const reconciler = readFileSync(
      resolve(ROOT, 'apps/api/src/requisition-integration/external-lifecycle-reconciler.ts'),
      'utf8',
    );
    const ingress = readFileSync(
      resolve(ROOT, 'apps/api/src/requisition-integration/lifecycle-ingress.service.ts'),
      'utf8',
    );
    // Both writers reference the shared const (aligned) and carry NO bare
    // quoted failure-reason literal in a reconcile() call.
    expect(reconciler).toMatch(/RECONCILIATION_FAILURE_REASON\./);
    expect(ingress).toMatch(/RECONCILIATION_FAILURE_REASON\./);
    for (const src of [reconciler, ingress]) {
      for (const token of RECONCILIATION_FAILURE_REASONS) {
        expect(src, `${token} must not appear as a bare quoted literal`).not.toMatch(
          new RegExp(`['\`]${token}['\`]`),
        );
      }
    }
  });
});

// -----------------------------------------------------------------------------
// Proof 9 — HARD PROHIBITION (ALWAYS, structural). The drain worker reaches
// Requisition state ONLY through the governed command seam — never a direct write.
// -----------------------------------------------------------------------------
describe('CB-D2-R proof 9 — HARD PROHIBITION: the drain worker never writes Requisition.status directly', () => {
  const worker = readFileSync(
    resolve(ROOT, 'apps/api/src/requisition-integration/reconciliation-drain.service.ts'),
    'utf8',
  );
  it('reaches requisition state ONLY via executeExternalLifecycleCommand, as the connector service account', () => {
    expect(worker).toMatch(/executeExternalLifecycleCommand/);
    expect(worker).toMatch(/CONNECTOR_SERVICE_ACCOUNT_ID/);
    // No direct prisma / repo write of the requisition model/status.
    expect(worker).not.toMatch(/\.requisition\.update(Many)?\s*\(/i);
    expect(worker).not.toMatch(/\.requisition\.(create|upsert)\s*\(/i);
    expect(worker).not.toMatch(/requisitions\s*\.\s*update\s*\(/i);
    expect(worker).not.toMatch(/UPDATE\s+["'`]?requisition["'`]?\s*\.\s*["'`]?Requisition/i);
  });
});

// -----------------------------------------------------------------------------
// Proofs 1-7 — the DB-backed drain (real Postgres 17). Glob migrations auto-apply
// the CB-D2-R ALTER.
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

const TENANT = '01900000-0000-7000-8000-0000000000d1';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

let seq = 0;
const uuid = (): string => `00000000-0000-7000-8000-${(++seq).toString(16).padStart(12, '0')}`;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'CB-D2-R — reconciliation drain worker (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let storePrisma: PolicyStorePrismaService;
    let app: INestApplication;
    let drain: RequisitionReconciliationDrainService;
    let identities: ExternalRequisitionIdentityRepository;
    let mappings: RequisitionLifecycleMappingRepository;
    let establishment: RequisitionIdentityEstablishmentService;
    let requisitions: RequisitionRepository;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    async function seedReq(
      tenant: string,
      status: string,
      opts: { import_batch_id?: string; external_req_id?: string; source_system?: string } = {},
    ): Promise<string> {
      const id = uuid();
      await db.query(
        `WITH seq AS (
           INSERT INTO requisition."RequisitionNumberSequence" (tenant_id, next_value)
           VALUES ($2::uuid, 1000)
           ON CONFLICT (tenant_id) DO UPDATE SET next_value = requisition."RequisitionNumberSequence".next_value + 1
           RETURNING next_value
         )
         INSERT INTO requisition."Requisition"
           (id, tenant_id, title, company_id, status, requisition_number, import_batch_id, source_system, external_req_id)
         SELECT $1,$2,$3,$4,$5::"requisition"."RecruitingStatus",(SELECT next_value FROM seq),$6::uuid,$7,$8`,
        [
          id, tenant, `r-${status}`, uuid(), status,
          opts.import_batch_id ?? null, opts.source_system ?? null, opts.external_req_id ?? null,
        ],
      );
      return id;
    }

    async function seedConnection(tenant: string, providerKey = 'fieldglass'): Promise<string> {
      const id = uuid();
      await db.query(
        `INSERT INTO integration."IntegrationConnection" (id, tenant_id, provider_key, status, updated_at)
         VALUES ($1,$2,$3,'active', now())`,
        [id, tenant, providerKey],
      );
      return id;
    }

    // Seed a pending reconciliation row exactly as the A1/FG writers do (D1 writes
    // 'pending' only; worker-state columns start at their defaults/null).
    async function seedRecon(args: {
      tenant?: string;
      connection_id: string;
      failure_reason: string;
      external_req_id?: string | null;
      provider_key?: string;
      raw_provider_status?: string;
      normalized_status?: string | null;
      mapped_action?: string | null;
      current_aramo_status?: string | null;
    }): Promise<{ id: string; external_event_id: string }> {
      const id = uuid();
      const externalEventId = `evt-${id}`;
      await db.query(
        `INSERT INTO integration."RequisitionExternalReconciliation"
           (id, tenant_id, connection_id, external_event_id, external_req_id, provider_key,
            raw_provider_status, normalized_status, mapped_action, current_aramo_status,
            failure_reason, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')`,
        [
          id, args.tenant ?? TENANT, args.connection_id, externalEventId,
          args.external_req_id ?? null, args.provider_key ?? 'fieldglass',
          args.raw_provider_status ?? 'on_hold', args.normalized_status ?? null,
          args.mapped_action ?? null, args.current_aramo_status ?? null, args.failure_reason,
        ],
      );
      return { id, external_event_id: externalEventId };
    }

    async function reconOf(id: string): Promise<{
      status: string; resolution_reason: string | null; attempts: number;
      next_attempt_at: Date | null; locked_until: Date | null;
    }> {
      const r = (await db.query(
        `SELECT status, resolution_reason, attempts, next_attempt_at, locked_until
           FROM integration."RequisitionExternalReconciliation" WHERE id=$1`, [id],
      )).rows[0];
      return { ...r, attempts: Number(r.attempts) };
    }

    async function reqOf(id: string): Promise<{ status: string; version: number }> {
      const r = (await db.query(`SELECT status, version FROM requisition."Requisition" WHERE id=$1`, [id])).rows[0];
      return { status: r.status, version: Number(r.version) };
    }
    async function eventCount(reqId: string): Promise<number> {
      return Number((await db.query(
        `SELECT count(*)::int AS c FROM requisition."RequisitionLifecycleEvent" WHERE requisition_id=$1`, [reqId],
      )).rows[0].c);
    }
    async function provenanceCount(externalEventId: string): Promise<number> {
      return Number((await db.query(
        `SELECT count(*)::int AS c FROM integration."RequisitionExternalTransitionProvenance" WHERE external_event_id=$1`,
        [externalEventId],
      )).rows[0].c);
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT);
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1,'ats') ON CONFLICT DO NOTHING`,
        [TENANT],
      );

      storePrisma = new PolicyStorePrismaService(url);
      await storePrisma.$connect();
      const store = new PolicyStore(storePrisma);
      await store.publish({ tenant_id: TENANT, definition: REQUISITION_LIFECYCLE_PACKAGE, published_by: SYSTEM });

      const kp = await generateKeyPair('RS256');
      const pem = await exportSPKI(kp.publicKey as never);
      savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'] };
      process.env['DATABASE_URL'] = url; process.env['AUTH_AUDIENCE'] = 'aramo-cbd2r-spec'; process.env['AUTH_PUBLIC_KEY'] = pem;

      const mod: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      await app.init();
      drain = app.get(RequisitionReconciliationDrainService);
      identities = app.get(ExternalRequisitionIdentityRepository);
      mappings = app.get(RequisitionLifecycleMappingRepository);
      establishment = app.get(RequisitionIdentityEstablishmentService);
      requisitions = app.get(RequisitionRepository);
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await storePrisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }, 60_000);

    it('proof 1 — RE_EVALUABLE (mapping): an UNMAPPABLE row, mapping now seeded, drains to resolved via the governed seam', async () => {
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT);
      await identities.record({ tenant_id: TENANT, connection_id: connId, external_req_id: 'RE-1', requisition_id: reqId });
      // The mapping that was ABSENT when the row entered reconciliation is now authored.
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      const row = await seedRecon({
        connection_id: connId, failure_reason: RECONCILIATION_FAILURE_REASON.UNMAPPABLE_PROVIDER_STATE,
        external_req_id: 'RE-1', raw_provider_status: 'on_hold', normalized_status: 'on_hold',
      });

      // BEFORE (non-vacuous): the row is pending, the requisition is open.
      expect((await reconOf(row.id)).status).toBe('pending');
      expect(await reqOf(reqId)).toEqual({ status: 'open', version: 0 });

      const result = await drain.drainBatch();
      expect(result.attempted).toBe(1);
      expect(result.resolved).toBe(1);

      // AFTER — the governed transition committed (gate→CAS→atomic event).
      expect(await reqOf(reqId)).toEqual({ status: 'on_hold', version: 1 });
      expect(await eventCount(reqId)).toBe(1);
      expect(await provenanceCount(row.external_event_id)).toBe(1);
      const recon = await reconOf(row.id);
      expect(recon.status).toBe('resolved');
      expect(recon.resolution_reason).toBe(RECONCILIATION_DISPOSITION.RESOLVED_REEVALUATED);
    });

    it('proof 2 — RE_EVALUABLE (identity): REQUISITION_NOT_FOUND resolves after establishment; a null external_req_id parks (never guessed)', async () => {
      const connId = await seedConnection(TENANT);
      const batchId = uuid();
      const reqId = await seedReq(TENANT, 'open', { import_batch_id: batchId, external_req_id: 'EST-9', source_system: 'fieldglass' });
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      const resolvable = await seedRecon({
        connection_id: connId, failure_reason: RECONCILIATION_FAILURE_REASON.REQUISITION_NOT_FOUND,
        external_req_id: 'EST-9', raw_provider_status: 'on_hold',
      });
      // A structurally non-replayable row — no external identity at all.
      const nullId = await seedRecon({
        connection_id: connId, failure_reason: RECONCILIATION_FAILURE_REASON.REQUISITION_NOT_FOUND,
        external_req_id: null, raw_provider_status: 'on_hold',
      });

      // BEFORE — identity not yet established; both rows pending.
      expect(await identities.resolve(TENANT, connId, 'EST-9')).toBeNull();
      expect((await reconOf(resolvable.id)).status).toBe('pending');

      // Establish the identity, then drain once with maxAttempts=1 so the
      // non-replayable row parks in the same tick.
      expect(await establishment.establishForImportBatch({ tenant_id: TENANT, connection_id: connId, import_batch_id: batchId })).toBe(1);
      const result = await drain.drainBatch({ maxAttempts: 1, backoffMs: 0 });
      expect(result.attempted).toBe(2);
      expect(result.resolved).toBe(1);
      expect(result.parked).toBe(1);

      // The resolvable row transitioned via the governed seam.
      expect(await reqOf(reqId)).toEqual({ status: 'on_hold', version: 1 });
      expect(await eventCount(reqId)).toBe(1);
      expect((await reconOf(resolvable.id)).status).toBe('resolved');
      // The null-identity row parked — NEVER guessed to a requisition.
      const parked = await reconOf(nullId.id);
      expect(parked.status).toBe('parked');
      expect(parked.resolution_reason).toBe(RECONCILIATION_DISPOSITION.PARKED_NON_REPLAYABLE);
    });

    it('proof 3 — CAS_CONFLICT: a stale reload → the seam refuses again → bumped/backed-off, NOT blind-retried; at the cap → parked; the interfering edit survives', async () => {
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT);
      await identities.record({ tenant_id: TENANT, connection_id: connId, external_req_id: 'CAS-9', requisition_id: reqId });
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      const row = await seedRecon({
        connection_id: connId, failure_reason: RECONCILIATION_FAILURE_REASON.CAS_CONFLICT,
        external_req_id: 'CAS-9', raw_provider_status: 'on_hold', normalized_status: 'on_hold',
      });
      // A concurrent internal edit bumped version 0 → 1 and set an observable field.
      await db.query(`UPDATE requisition."Requisition" SET version=1, title='internal-edit-won' WHERE id=$1`, [reqId]);
      // Simulate the race window: the worker reloads a STALE version (0) — a
      // concurrent edit landed after its read. The REAL seam CAS (expected_version=0
      // vs DB version 1) then refuses with CAS_CONFLICT on every attempt.
      const spy = vi
        .spyOn(requisitions, 'findStatusAndVersionById')
        .mockResolvedValue({ status: 'open', version: 0 } as never);
      try {
        // Drain 1 — bumped/backed-off (NOT blind-retried within the tick).
        const first = await drain.drainBatch({ maxAttempts: 2, backoffMs: 0 });
        expect(first.attempted).toBe(1);
        expect(first.rescheduled).toBe(1);
        const mid = await reconOf(row.id);
        expect(mid.status).toBe('pending'); // still retryable, not parked
        expect(mid.attempts).toBe(1); // exactly ONE attempt consumed
        expect(mid.next_attempt_at).not.toBeNull(); // backoff scheduled

        // Drain 2 — attempt cap reached → parked (poison).
        const second = await drain.drainBatch({ maxAttempts: 2, backoffMs: 0 });
        expect(second.parked).toBe(1);
        const parked = await reconOf(row.id);
        expect(parked.status).toBe('parked');
        expect(parked.resolution_reason).toBe(RECONCILIATION_DISPOSITION.PARKED_POISON);
        expect(parked.attempts).toBe(2);
      } finally {
        spy.mockRestore();
      }

      // The interfering edit SURVIVES — no lost update, PUT_ON_HOLD never applied.
      expect(await reqOf(reqId)).toEqual({ status: 'open', version: 1 });
      expect(await eventCount(reqId)).toBe(0);
    });

    it('proof 4 — SUPERSEDED (ORDERING_STALE): drain marks resolved with NO Requisition mutation', async () => {
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT);
      await identities.record({ tenant_id: TENANT, connection_id: connId, external_req_id: 'SUP-1', requisition_id: reqId });
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'closed', mapped_action: 'CLOSE', authority_mode: 'external_authority' });
      const row = await seedRecon({
        connection_id: connId, failure_reason: RECONCILIATION_FAILURE_REASON.ORDERING_STALE,
        external_req_id: 'SUP-1', raw_provider_status: 'closed', normalized_status: 'closed',
      });

      expect(await reqOf(reqId)).toEqual({ status: 'open', version: 0 }); // BEFORE

      const result = await drain.drainBatch();
      expect(result.superseded).toBe(1);

      // AFTER — resolved with NO mutation (a newer observation already applied).
      expect(await reqOf(reqId)).toEqual({ status: 'open', version: 0 });
      expect(await eventCount(reqId)).toBe(0);
      const recon = await reconOf(row.id);
      expect(recon.status).toBe('resolved');
      expect(recon.resolution_reason).toBe(RECONCILIATION_DISPOSITION.RESOLVED_SUPERSEDED);
    });

    it('proof 5 — INTERVENTION (ILLEGAL/POLICY/AMBIGUOUS): after bounded attempts parked; NEVER auto-executes', async () => {
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT);
      await identities.record({ tenant_id: TENANT, connection_id: connId, external_req_id: 'INT-1', requisition_id: reqId });
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      const rows = await Promise.all([
        seedRecon({ connection_id: connId, failure_reason: RECONCILIATION_FAILURE_REASON.ILLEGAL_FROM_STATE, external_req_id: 'INT-1' }),
        seedRecon({ connection_id: connId, failure_reason: RECONCILIATION_FAILURE_REASON.POLICY_DENIED, external_req_id: 'INT-1' }),
        seedRecon({ connection_id: connId, failure_reason: RECONCILIATION_FAILURE_REASON.ORDERING_AMBIGUOUS, external_req_id: 'INT-1' }),
      ]);

      // Drain 1 — bumped+backed-off (never executed); Drain 2 — cap reached → parked.
      const first = await drain.drainBatch({ maxAttempts: 2, backoffMs: 0 });
      expect(first.rescheduled).toBe(3);
      for (const r of rows) expect((await reconOf(r.id)).status).toBe('pending');

      const second = await drain.drainBatch({ maxAttempts: 2, backoffMs: 0 });
      expect(second.parked).toBe(3);
      for (const r of rows) {
        const recon = await reconOf(r.id);
        expect(recon.status).toBe('parked');
        expect(recon.resolution_reason).toBe(RECONCILIATION_DISPOSITION.PARKED_INTERVENTION);
      }
      // NEVER auto-executed a transition.
      expect(await reqOf(reqId)).toEqual({ status: 'open', version: 0 });
      expect(await eventCount(reqId)).toBe(0);
    });

    it('proof 6 — DUAL_CONTROL excluded: a DUAL_CONTROL_PENDING row is never claimed/executed', async () => {
      const connId = await seedConnection(TENANT);
      const row = await seedRecon({
        connection_id: connId, failure_reason: RECONCILIATION_FAILURE_REASON.DUAL_CONTROL_PENDING,
        external_req_id: 'DC-1', mapped_action: 'PUT_ON_HOLD',
      });

      const result = await drain.drainBatch();
      expect(result.attempted).toBe(0); // never claimed

      // Untouched — still pending, attempts never incremented (proves not claimed).
      const recon = await reconOf(row.id);
      expect(recon.status).toBe('pending');
      expect(recon.attempts).toBe(0);
      expect(recon.locked_until).toBeNull();
    });

    it('proof 7 — CLAIM concurrency: two concurrent drains process each row once; a parked row is not re-picked', async () => {
      const connId = await seedConnection(TENANT);
      const reqs: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const reqId = await seedReq(TENANT, 'open');
        const ext = `CC-${i}`;
        await identities.record({ tenant_id: TENANT, connection_id: connId, external_req_id: ext, requisition_id: reqId });
        await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: `s${i}`, mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
        await seedRecon({
          connection_id: connId, failure_reason: RECONCILIATION_FAILURE_REASON.UNMAPPABLE_PROVIDER_STATE,
          external_req_id: ext, raw_provider_status: `s${i}`, normalized_status: `s${i}`,
        });
        reqs.push(reqId);
      }
      // A pre-parked poison row must NEVER be re-picked by the poll.
      const preParked = await seedRecon({
        connection_id: connId, failure_reason: RECONCILIATION_FAILURE_REASON.UNMAPPABLE_PROVIDER_STATE,
        external_req_id: 'CC-parked', raw_provider_status: 'x',
      });
      await db.query(
        `UPDATE integration."RequisitionExternalReconciliation" SET status='parked', resolution_reason=$2 WHERE id=$1`,
        [preParked.id, RECONCILIATION_DISPOSITION.PARKED_POISON],
      );

      // Two concurrent drains — SKIP LOCKED partitions the rows (no double-claim).
      const [a, b] = await Promise.all([drain.drainBatch(), drain.drainBatch()]);
      expect(a.attempted + b.attempted).toBe(4); // each of the 4 rows claimed exactly once
      expect(a.resolved + b.resolved).toBe(4);

      // Each requisition transitioned EXACTLY once (no double-apply).
      for (const reqId of reqs) {
        expect(await reqOf(reqId)).toEqual({ status: 'on_hold', version: 1 });
        expect(await eventCount(reqId)).toBe(1);
      }
      // The pre-parked row was never claimed (still parked, attempts unchanged).
      const parked = await reconOf(preParked.id);
      expect(parked.status).toBe('parked');
      expect(parked.attempts).toBe(0);
    });
  },
);
