import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair } from 'jose';
import { PolicyStore, PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';
import {
  ExternalRequisitionIdentityRepository,
  LifecycleObservationLedgerRepository,
  LifecycleSourceAdapterRegistry,
  RequisitionLifecycleMappingRepository,
  type ExternalRequisitionLifecycleEvent,
  type ExternalRequisitionLifecycleObservation,
  type LifecycleFetchResult,
} from '@aramo/integration';

import { AppModule } from '../app.module.js';
import { REQUISITION_LIFECYCLE_PACKAGE } from '../policy/requisition-lifecycle.package.js';
import { LifecycleIngressService } from '../requisition-integration/lifecycle-ingress.service.js';
import { LifecyclePollProducer } from '../requisition-integration/lifecycle-poll.producer.js';
import { RequisitionIdentityEstablishmentService } from '../requisition-integration/requisition-identity-establishment.service.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';
import { placementCapacityMigrations } from './support/placement-capacity-migrations.js';
import { FakeLifecycleSource } from './support/fake-lifecycle-source.js';

// CB-D2-A1 (ADR-0030) — the provider-NEUTRAL lifecycle ingress substrate,
// end-to-end against real Postgres 17 through the full app, driven by a FAKE
// lifecycle source + synthetic observations/events (NO live provider / adapter
// runtime — those are later slices). Proves:
//   1. STATE-OBSERVATION → identity resolve → governed command; NO provider_event_at fabricated.
//   2. IDEMPOTENCY (A0-R5): same stored delivery → ONE outcome; a NEW delivery re-observing → not collapsed.
//   3. RAW-DURABILITY: the raw ledger row persists BEFORE the command; cursor advances only post-success.
//   4. ORDERING (A0-R4): UNKNOWN out-of-order → reconciliation; STRONG rejects a stale event.
//   5. IDENTITY connection-scoping: same external_req_id on a DIFFERENT connection → different/no requisition.
//   6. IDENTITY ESTABLISHMENT: import establishes → identity row written → later observation resolves via it.
//   7. EVENT-CAPABLE (WD-shaped) synthetic event flows through with its confidence class.
//   8. CAS SEPARATION: provider ordering NEVER sets Requisition.version.

const ROOT = resolve(__dirname, '../../../..');

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

const TENANT = '01900000-0000-7000-8000-0000000000f1';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

let seq = 0;
const uuid = (): string => `00000000-0000-7000-8000-${(++seq).toString(16).padStart(12, '0')}`;

function observation(
  externalReqId: string,
  status: string,
  observedAt: string,
): ExternalRequisitionLifecycleObservation {
  return {
    kind: 'observation',
    external_req_id: externalReqId,
    observed_status: status,
    observed_at: observedAt,
    provider_event_at: null,
    provider_sequence: null,
    ordering_confidence: 'unknown',
  };
}

function event(
  externalReqId: string,
  externalEventId: string,
  status: string,
  providerEventAt: string,
  providerSequence: number | null,
): ExternalRequisitionLifecycleEvent {
  return {
    kind: 'event',
    external_req_id: externalReqId,
    external_event_id: externalEventId,
    observed_status: status,
    provider_event_at: providerEventAt,
    provider_sequence: providerSequence,
    ordering_confidence: 'strong',
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'CB-D2-A1 — provider-neutral lifecycle ingress (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let storePrisma: PolicyStorePrismaService;
    let app: INestApplication;
    let ingress: LifecycleIngressService;
    let producer: LifecyclePollProducer;
    let identities: ExternalRequisitionIdentityRepository;
    let ledger: LifecycleObservationLedgerRepository;
    let mappings: RequisitionLifecycleMappingRepository;
    let registry: LifecycleSourceAdapterRegistry;
    let establishment: RequisitionIdentityEstablishmentService;
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
          id,
          tenant,
          `r-${status}`,
          uuid(),
          status,
          opts.import_batch_id ?? null,
          opts.source_system ?? null,
          opts.external_req_id ?? null,
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

    async function statusOf(id: string): Promise<{ status: string; version: number }> {
      return (await db.query(`SELECT status, version FROM requisition."Requisition" WHERE id=$1`, [id])).rows[0];
    }
    async function ledgerRows(connectionId: string, externalReqId: string): Promise<
      Array<{ observation_key: string; status: string; outcome: string | null; provider_event_at: Date | null; provider_sequence: string | null }>
    > {
      return (
        await db.query(
          `SELECT observation_key, status, outcome, provider_event_at, provider_sequence
             FROM integration."LifecycleObservationLedger"
             WHERE connection_id=$1 AND external_req_id=$2 ORDER BY created_at ASC`,
          [connectionId, externalReqId],
        )
      ).rows;
    }
    async function reconRow(connectionId: string, externalEventId: string): Promise<Record<string, unknown> | undefined> {
      return (
        await db.query(
          `SELECT * FROM integration."RequisitionExternalReconciliation" WHERE connection_id=$1 AND external_event_id=$2`,
          [connectionId, externalEventId],
        )
      ).rows[0];
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
      process.env['DATABASE_URL'] = url; process.env['AUTH_AUDIENCE'] = 'aramo-cbd2a1-spec'; process.env['AUTH_PUBLIC_KEY'] = pem;

      const mod: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      await app.init();
      ingress = app.get(LifecycleIngressService);
      producer = app.get(LifecyclePollProducer);
      identities = app.get(ExternalRequisitionIdentityRepository);
      ledger = app.get(LifecycleObservationLedgerRepository);
      mappings = app.get(RequisitionLifecycleMappingRepository);
      registry = app.get(LifecycleSourceAdapterRegistry);
      establishment = app.get(RequisitionIdentityEstablishmentService);
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await storePrisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }, 60_000);

    it('proof 1 — STATE-OBSERVATION: identity resolve → governed command executes; NO provider_event_at fabricated', async () => {
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      await identities.record({ tenant_id: TENANT, connection_id: connId, external_req_id: 'VMS-1', requisition_id: reqId });

      const obs = observation('VMS-1', 'on_hold', '2026-08-27T10:00:00.000Z');
      // Canonical honesty — the observation carries NO provider event timestamp.
      expect(obs.provider_event_at).toBeNull();
      expect(obs.provider_sequence).toBeNull();

      expect((await statusOf(reqId)).status).toBe('open'); // BEFORE

      const result = await ingress.ingest({ tenant_id: TENANT, connection_id: connId, provider_key: 'fieldglass', delivery_id: 'dlv-1', change: obs });
      expect(result).toEqual({ outcome: 'EXECUTED', next_status: 'on_hold' });

      const after = await statusOf(reqId); // AFTER
      expect(after.status).toBe('on_hold');
      expect(after.version).toBe(1);

      const rows = await ledgerRows(connId, 'VMS-1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('processed');
      expect(rows[0]?.outcome).toBe('EXECUTED');
      // NOT fabricated: the observation ledger row carries a NULL provider_event_at.
      expect(rows[0]?.provider_event_at).toBeNull();
      expect(rows[0]?.provider_sequence).toBeNull();
    });

    it('proof 2 — IDEMPOTENCY: same delivery → ONE outcome (DUPLICATE); a NEW delivery re-observing is NOT collapsed', async () => {
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      await identities.record({ tenant_id: TENANT, connection_id: connId, external_req_id: 'VMS-2', requisition_id: reqId });

      const obs = observation('VMS-2', 'on_hold', '2026-08-27T10:00:00.000Z');
      const first = await ingress.ingest({ tenant_id: TENANT, connection_id: connId, provider_key: 'fieldglass', delivery_id: 'dlv-A', change: obs });
      expect(first).toEqual({ outcome: 'EXECUTED', next_status: 'on_hold' });
      expect((await statusOf(reqId)).version).toBe(1);

      // Reprocess the SAME stored delivery → ONE outcome, no double-apply.
      const replay = await ingress.ingest({ tenant_id: TENANT, connection_id: connId, provider_key: 'fieldglass', delivery_id: 'dlv-A', change: obs });
      expect(replay).toEqual({ outcome: 'DUPLICATE' });
      expect((await statusOf(reqId)).version).toBe(1); // NOT double-incremented
      expect(await ledgerRows(connId, 'VMS-2')).toHaveLength(1); // still ONE row for dlv-A

      // A NEW delivery re-observing the same requisition at the same status is a
      // NEW ledger row (not permanently collapsed) — it is re-processed (and here
      // refused as already-on_hold, routed to reconciliation).
      const next = await ingress.ingest({ tenant_id: TENANT, connection_id: connId, provider_key: 'fieldglass', delivery_id: 'dlv-B', change: obs });
      expect(next.outcome).toBe('RECONCILED');
      expect(await ledgerRows(connId, 'VMS-2')).toHaveLength(2); // dlv-A + dlv-B — NOT collapsed
    });

    it('proof 3 — RAW-DURABILITY: the raw ledger row persists even when the command reconciles; the poll cursor advances only post-success', async () => {
      const connId = await seedConnection(TENANT);
      // NO identity established for UNMAPPED-1 → the ingress reconciles, but the
      // RAW observation row MUST still be durably persisted (persist-before-process).
      const obs = observation('UNMAPPED-1', 'on_hold', '2026-08-27T10:00:00.000Z');
      const result = await ingress.ingest({ tenant_id: TENANT, connection_id: connId, provider_key: 'fieldglass', delivery_id: 'dlv-C', change: obs });
      expect(result).toEqual({ outcome: 'RECONCILED', reason: 'REQUISITION_NOT_FOUND' });
      const durable = await ledger.findByKey(TENANT, connId, 'dlv-C:UNMAPPED-1');
      expect(durable).not.toBeNull(); // raw row persisted regardless of command outcome
      expect(durable?.status).toBe('reconciled');

      // Cursor advances only after a successful poll. BEFORE: null.
      const reqId = await seedReq(TENANT, 'open');
      const pollConnId = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: pollConnId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      await identities.record({ tenant_id: TENANT, connection_id: pollConnId, external_req_id: 'POLL-1', requisition_id: reqId });
      const before = (await db.query(`SELECT cursor FROM integration."IntegrationConnection" WHERE id=$1`, [pollConnId])).rows[0];
      expect(before.cursor).toBeNull();

      const fetch: LifecycleFetchResult = {
        delivery: { delivery_id: 'poll-dlv-1', received_at: '2026-08-27T11:00:00.000Z' },
        changes: [observation('POLL-1', 'on_hold', '2026-08-27T11:00:00.000Z')],
        next_cursor: 'watermark-2',
      };
      registry.register(new FakeLifecycleSource('fieldglass', [fetch]));
      await producer.pollConnection({ id: pollConnId, tenant_id: TENANT, provider_key: 'fieldglass', cursor: null });

      expect((await statusOf(reqId)).status).toBe('on_hold'); // the observation was durably processed
      const afterCursor = (await db.query(`SELECT cursor FROM integration."IntegrationConnection" WHERE id=$1`, [pollConnId])).rows[0];
      expect(afterCursor.cursor).toBe('watermark-2'); // advanced ONLY after success
    });

    it('proof 4 — ORDERING (A0-R4): UNKNOWN out-of-apparent-order → reconciliation; a STRONG event rejects a stale one', async () => {
      // UNKNOWN out-of-order: an earlier-observed observation must NOT overwrite.
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'closed', mapped_action: 'CLOSE', authority_mode: 'external_authority' });
      await identities.record({ tenant_id: TENANT, connection_id: connId, external_req_id: 'ORD-1', requisition_id: reqId });

      const later = await ingress.ingest({ tenant_id: TENANT, connection_id: connId, provider_key: 'fieldglass', delivery_id: 'ord-late', change: observation('ORD-1', 'on_hold', '2026-08-27T12:00:00.000Z') });
      expect(later).toEqual({ outcome: 'EXECUTED', next_status: 'on_hold' });

      const earlier = await ingress.ingest({ tenant_id: TENANT, connection_id: connId, provider_key: 'fieldglass', delivery_id: 'ord-early', change: observation('ORD-1', 'closed', '2026-08-27T09:00:00.000Z') });
      expect(earlier).toEqual({ outcome: 'RECONCILED', reason: 'ORDERING_AMBIGUOUS' });
      expect((await statusOf(reqId)).status).toBe('on_hold'); // NOT overwritten to closed

      // STRONG rejects a stale sequence.
      const reqId2 = await seedReq(TENANT, 'open');
      const connId2 = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId2, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId2, provider_state: 'closed', mapped_action: 'CLOSE', authority_mode: 'external_authority' });
      await identities.record({ tenant_id: TENANT, connection_id: connId2, external_req_id: 'ORD-2', requisition_id: reqId2 });

      const seq5 = await ingress.ingest({ tenant_id: TENANT, connection_id: connId2, provider_key: 'fieldglass', delivery_id: 'x', change: event('ORD-2', 'evt-5', 'on_hold', '2026-08-27T12:00:00.000Z', 5) });
      expect(seq5).toEqual({ outcome: 'EXECUTED', next_status: 'on_hold' });
      const seq3 = await ingress.ingest({ tenant_id: TENANT, connection_id: connId2, provider_key: 'fieldglass', delivery_id: 'x', change: event('ORD-2', 'evt-3', 'closed', '2026-08-27T11:00:00.000Z', 3) });
      expect(seq3).toEqual({ outcome: 'RECONCILED', reason: 'ORDERING_STALE' });
      expect((await statusOf(reqId2)).status).toBe('on_hold'); // stale event rejected
    });

    it('proof 5 — IDENTITY connection-scoping: same external_req_id on a DIFFERENT connection resolves to a different/no requisition', async () => {
      const reqA = await seedReq(TENANT, 'open');
      const connA = await seedConnection(TENANT, 'fieldglass');
      const connB = await seedConnection(TENANT, 'beeline'); // different connection, same tenant
      await identities.record({ tenant_id: TENANT, connection_id: connA, external_req_id: 'SHARED-1', requisition_id: reqA });

      // Connection A resolves to reqA; connection B resolves to NULL (no guess).
      expect(await identities.resolve(TENANT, connA, 'SHARED-1')).toBe(reqA);
      expect(await identities.resolve(TENANT, connB, 'SHARED-1')).toBeNull();

      // Ingress on connection B for the SAME external_req_id → reconciliation, never a guess.
      const result = await ingress.ingest({ tenant_id: TENANT, connection_id: connB, provider_key: 'beeline', delivery_id: 'b-dlv', change: observation('SHARED-1', 'on_hold', '2026-08-27T10:00:00.000Z') });
      expect(result).toEqual({ outcome: 'RECONCILED', reason: 'REQUISITION_NOT_FOUND' });
      expect((await statusOf(reqA)).status).toBe('open'); // connection A's requisition untouched
      expect((await reconRow(connB, 'b-dlv:SHARED-1'))?.['failure_reason']).toBe('REQUISITION_NOT_FOUND');
    });

    it('proof 6 — IDENTITY ESTABLISHMENT: an import establishes the identity row; a later observation resolves via it', async () => {
      const batchId = uuid();
      const connId = await seedConnection(TENANT);
      const reqId = await seedReq(TENANT, 'open', { import_batch_id: batchId, external_req_id: 'EST-1', source_system: 'fieldglass' });
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });

      // BEFORE — no identity row yet.
      expect(await identities.resolve(TENANT, connId, 'EST-1')).toBeNull();

      const recorded = await establishment.establishForImportBatch({ tenant_id: TENANT, connection_id: connId, import_batch_id: batchId });
      expect(recorded).toBe(1);
      // AFTER — the (connection, external_req_id) → requisition_id row was written.
      expect(await identities.resolve(TENANT, connId, 'EST-1')).toBe(reqId);

      // A later observation on that connection resolves via the established identity.
      const result = await ingress.ingest({ tenant_id: TENANT, connection_id: connId, provider_key: 'fieldglass', delivery_id: 'est-dlv', change: observation('EST-1', 'on_hold', '2026-08-27T13:00:00.000Z') });
      expect(result).toEqual({ outcome: 'EXECUTED', next_status: 'on_hold' });
      expect((await statusOf(reqId)).status).toBe('on_hold');
    });

    it('proof 7 — EVENT-CAPABLE (WD-shaped): an event with external_event_id + provider_event_at flows through with its confidence class', async () => {
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT, 'workday');
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      await identities.record({ tenant_id: TENANT, connection_id: connId, external_req_id: 'WD-1', requisition_id: reqId });

      const result = await ingress.ingest({ tenant_id: TENANT, connection_id: connId, provider_key: 'workday', delivery_id: 'wd-dlv', change: event('WD-1', 'wd-evt-1', 'on_hold', '2026-08-27T14:00:00.000Z', 7) });
      expect(result).toEqual({ outcome: 'EXECUTED', next_status: 'on_hold' });

      const rows = await ledgerRows(connId, 'WD-1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.observation_key).toBe('wd-evt-1'); // the provider event id is the durable key
      // The event carries a REAL provider event timestamp + sequence (not null).
      expect(rows[0]?.provider_event_at).not.toBeNull();
      expect(rows[0]?.provider_sequence).toBe('7');
    });

    it('proof 8 — CAS SEPARATION: provider ordering NEVER sets Requisition.version', async () => {
      const reqId = await seedReq(TENANT, 'open'); // version 0
      const connId = await seedConnection(TENANT, 'workday');
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'on_hold', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      await identities.record({ tenant_id: TENANT, connection_id: connId, external_req_id: 'CAS-1', requisition_id: reqId });

      expect((await statusOf(reqId)).version).toBe(0); // BEFORE
      // A provider sequence of 99 must NEVER become the CAS predicate.
      const result = await ingress.ingest({ tenant_id: TENANT, connection_id: connId, provider_key: 'workday', delivery_id: 'cas-dlv', change: event('CAS-1', 'cas-evt-1', 'on_hold', '2026-08-27T15:00:00.000Z', 99) });
      expect(result).toEqual({ outcome: 'EXECUTED', next_status: 'on_hold' });

      const after = await statusOf(reqId);
      expect(after.version).toBe(1); // incremented by exactly 1 by the governed CAS — NOT set to 99
    });
  },
);
