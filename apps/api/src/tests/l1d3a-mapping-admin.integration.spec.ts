import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair } from 'jose';
import { PolicyStore, PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';
import {
  MAPPING_DISPOSITION,
  MappingAdminServiceError,
  RequisitionLifecycleMappingAdminService,
  RequisitionLifecycleMappingRepository,
} from '@aramo/integration';

import { AppModule } from '../app.module.js';
import { REQUISITION_LIFECYCLE_PACKAGE } from '../policy/requisition-lifecycle.package.js';
import { ExternalLifecycleReconciler } from '../requisition-integration/external-lifecycle-reconciler.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';
import { placementCapacityMigrations } from './support/placement-capacity-migrations.js';

// L1-D3-A — VMS Lifecycle Mapping Administration, end-to-end against real Postgres
// 17 through the full app. Proves the versioned mapping-set substrate + admin
// service + the runtime consumption change. Maps to the LOCKED directive DoD.

const ROOT = resolve(__dirname, '../../../..');

// -----------------------------------------------------------------------------
// Structural proof (ALWAYS runs) — DoD #16/#17: no mapping-admin / connector /
// integration code writes Requisition.status directly; the ONLY external path is
// the governed command seam (in libs/requisition, excluded — the sanctioned path).
// -----------------------------------------------------------------------------
describe('L1-D3-A structural — no direct Requisition.status write in mapping-admin/connector code', () => {
  function walkTs(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = resolve(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === 'generated' || name === 'node_modules') continue;
        out.push(...walkTs(p));
      } else if (name.endsWith('.ts')) out.push(p);
    }
    return out;
  }
  const scanned = [
    ...walkTs(resolve(ROOT, 'libs/integration/src')),
    ...walkTs(resolve(ROOT, 'apps/api/src/requisition-integration')),
  ];
  it('scans a non-empty surface incl. the new mapping-admin code', () => {
    expect(scanned.some((f) => f.includes('mapping-admin'))).toBe(true);
  });
  it('no file writes the requisition table / status directly', () => {
    for (const file of scanned) {
      const content = readFileSync(file, 'utf8');
      expect(content, `${file}: prisma requisition.update`).not.toMatch(/\.requisition\.update(Many)?\s*\(/i);
      expect(content, `${file}: raw UPDATE requisition.Requisition`).not.toMatch(
        /UPDATE\s+["'`]?requisition["'`]?\s*\.\s*["'`]?Requisition/i,
      );
    }
  });
});

// -----------------------------------------------------------------------------
// DB-backed proofs (real Postgres 17). The integration migration GLOB auto-applies
// the new mapping-set migration.
// -----------------------------------------------------------------------------
function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = [
  ...migrationsFor('entitlement'),
  ...migrationsFor('requisition'),
  ...migrationsFor('policy-store'),
  ...migrationsFor('integration'),
  ...placementCapacityMigrations(ROOT),
];

const TENANT_A = '01900000-0000-7000-8000-0000000000e1'; // policy published
const TENANT_B = '01900000-0000-7000-8000-0000000000e3';
const ACTOR = '01900000-0000-7000-8000-00000000aa01';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

let seq = 0;
const uuid = (): string => `00000000-0000-7000-8000-${(++seq).toString(16).padStart(12, '0')}`;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L1-D3-A — VMS lifecycle mapping administration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let storePrisma: PolicyStorePrismaService;
    let app: INestApplication;
    let admin: RequisitionLifecycleMappingAdminService;
    let mappings: RequisitionLifecycleMappingRepository;
    let reconciler: ExternalLifecycleReconciler;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    async function seedConnection(tenant: string): Promise<string> {
      const id = uuid();
      await db.query(
        `INSERT INTO integration."IntegrationConnection" (id, tenant_id, provider_key, status, updated_at)
         VALUES ($1,$2,'fieldglass','active', now())`,
        [id, tenant],
      );
      return id;
    }
    async function seedReq(tenant: string, status: string): Promise<string> {
      const id = uuid();
      await db.query(
        `WITH seq AS (
           INSERT INTO requisition."RequisitionNumberSequence" (tenant_id, next_value)
           VALUES ($2::uuid, 2000) ON CONFLICT (tenant_id) DO UPDATE
             SET next_value = requisition."RequisitionNumberSequence".next_value + 1
           RETURNING next_value)
         INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, status, requisition_number)
         SELECT $1,$2,$3,$4,$5::"requisition"."RecruitingStatus",(SELECT next_value FROM seq)`,
        [id, tenant, `r-${status}`, uuid(), status],
      );
      return id;
    }
    async function statusOf(id: string): Promise<string> {
      return (await db.query(`SELECT status FROM requisition."Requisition" WHERE id=$1`, [id])).rows[0].status;
    }
    async function setsOf(connId: string): Promise<Array<{ version: number; status: string }>> {
      return (
        await db.query(
          `SELECT version, status FROM integration."RequisitionLifecycleMappingSet" WHERE connection_id=$1 ORDER BY version`,
          [connId],
        )
      ).rows;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      for (const t of [TENANT_A, TENANT_B]) {
        await ensureWriteFreezeTenant((s) => db.query(s), t);
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1,'ats') ON CONFLICT DO NOTHING`,
          [t],
        );
      }
      storePrisma = new PolicyStorePrismaService(url);
      await storePrisma.$connect();
      await new PolicyStore(storePrisma).publish({
        tenant_id: TENANT_A,
        definition: REQUISITION_LIFECYCLE_PACKAGE,
        published_by: SYSTEM,
      });
      const kp = await generateKeyPair('RS256');
      const pem = await exportSPKI(kp.publicKey as never);
      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = 'aramo-l1d3a-spec';
      process.env['AUTH_PUBLIC_KEY'] = pem;

      const mod: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      await app.init();
      admin = app.get(RequisitionLifecycleMappingAdminService);
      mappings = app.get(RequisitionLifecycleMappingRepository);
      reconciler = app.get(ExternalLifecycleReconciler);
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await storePrisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    // Helper: author + activate a v1 set with a single EXECUTE row.
    async function activateSingle(tenant: string, connId: string, state: string, action: string): Promise<number> {
      const draft = await admin.createDraft(tenant, connId, ACTOR, [
        { provider_state: state, disposition: MAPPING_DISPOSITION.EXECUTE_ACTION, mapped_action: action },
      ]);
      await admin.activateSet(tenant, connId, draft.version, ACTOR);
      return draft.version;
    }

    it('#1/#19 — a cross-tenant / unknown connection conceals as CONNECTION_NOT_FOUND', async () => {
      const connA = await seedConnection(TENANT_A);
      // TENANT_B cannot see TENANT_A's connection.
      await expect(admin.listSets(TENANT_B, connA)).rejects.toMatchObject({
        code: 'CONNECTION_NOT_FOUND',
      } as Partial<MappingAdminServiceError>);
    });

    it('#2 — the same provider state maps DIFFERENTLY on two connections', async () => {
      const connA = await seedConnection(TENANT_A);
      const connB = await seedConnection(TENANT_A);
      await activateSingle(TENANT_A, connA, 'halted', 'PUT_ON_HOLD');
      await activateSingle(TENANT_A, connB, 'halted', 'CLOSE');
      expect((await mappings.findByConnectionState(TENANT_A, connA, 'halted'))?.mapped_action).toBe('PUT_ON_HOLD');
      expect((await mappings.findByConnectionState(TENANT_A, connB, 'halted'))?.mapped_action).toBe('CLOSE');
    });

    it('#4/#5/#6 — activation is atomic; exactly one active; prior version becomes historical + immutable', async () => {
      const conn = await seedConnection(TENANT_A);
      const v1 = await activateSingle(TENANT_A, conn, 'closed', 'CLOSE');
      // author + activate v2
      const draft2 = await admin.createDraft(TENANT_A, conn, ACTOR, [
        { provider_state: 'closed', disposition: MAPPING_DISPOSITION.EXECUTE_ACTION, mapped_action: 'CANCEL' },
      ]);
      await admin.activateSet(TENANT_A, conn, draft2.version, ACTOR);
      const sets = await setsOf(conn);
      // exactly ONE active
      expect(sets.filter((s) => s.status === 'active')).toHaveLength(1);
      expect(sets.find((s) => s.version === v1)?.status).toBe('historical');
      expect(sets.find((s) => s.version === draft2.version)?.status).toBe('active');
      // editing the now-historical v1 is REJECTED (immutable)
      await expect(
        admin.replaceDraftRows(TENANT_A, conn, v1, ACTOR, []),
      ).rejects.toMatchObject({ code: 'MAPPING_SET_NOT_DRAFT' });
    });

    it('#3/#7 — a draft does NOT affect runtime; runtime resolves ONLY the active set', async () => {
      const conn = await seedConnection(TENANT_A);
      await activateSingle(TENANT_A, conn, 'withdrawn', 'CANCEL'); // v1 active
      // author a DRAFT v2 that would map withdrawn -> CLOSE, and edit it
      const draft = await admin.createDraft(TENANT_A, conn, ACTOR, [
        { provider_state: 'withdrawn', disposition: MAPPING_DISPOSITION.EXECUTE_ACTION, mapped_action: 'CLOSE' },
      ]);
      await admin.replaceDraftRows(TENANT_A, conn, draft.version, ACTOR, [
        { provider_state: 'withdrawn', disposition: MAPPING_DISPOSITION.EXECUTE_ACTION, mapped_action: 'REOPEN' },
      ]);
      // runtime STILL resolves the active v1 (CANCEL), unaffected by the draft edits
      expect((await mappings.findByConnectionState(TENANT_A, conn, 'withdrawn'))?.mapped_action).toBe('CANCEL');
      // activate v2 -> runtime now resolves REOPEN
      await admin.activateSet(TENANT_A, conn, draft.version, ACTOR);
      expect((await mappings.findByConnectionState(TENANT_A, conn, 'withdrawn'))?.mapped_action).toBe('REOPEN');
    });

    it('#7/#8 — runtime EXECUTES via the active set and provenance carries the active version', async () => {
      const conn = await seedConnection(TENANT_A);
      const req = await seedReq(TENANT_A, 'open');
      const v1 = await activateSingle(TENANT_A, conn, 'on_hold', 'PUT_ON_HOLD');
      const eventId = uuid();
      expect(await statusOf(req)).toBe('open');
      const result = await reconciler.ingest({
        tenant_id: TENANT_A, connection_id: conn, provider_key: 'fieldglass',
        external_event_id: eventId, external_req_id: 'VMS-9', requisition_id: req,
        external_event_at: '2026-08-27T10:00:00.000Z', raw_provider_status: 'on_hold',
      });
      expect(result.outcome).toBe('EXECUTED');
      expect(await statusOf(req)).toBe('on_hold');
      const prov = (
        await db.query(
          `SELECT mapping_version FROM integration."RequisitionExternalTransitionProvenance"
             WHERE connection_id=$1 AND external_event_id=$2`,
          [conn, eventId],
        )
      ).rows[0];
      expect(prov.mapping_version).toBe(v1); // provenance = the ACTIVE set version
    });

    it('#12 — IGNORE is an audited no-op: NO mutation and NO reconciliation row', async () => {
      const conn = await seedConnection(TENANT_A);
      const req = await seedReq(TENANT_A, 'open');
      // author the IGNORE state as the reconciler's normalized form (trim+lowercase)
      // will produce from the raw 'Reviewing' observation.
      await admin.createDraft(TENANT_A, conn, ACTOR, [
        { provider_state: 'reviewing', disposition: MAPPING_DISPOSITION.IGNORE },
      ]).then((d) => admin.activateSet(TENANT_A, conn, d.version, ACTOR));
      const eventId = uuid();
      const result = await reconciler.ingest({
        tenant_id: TENANT_A, connection_id: conn, provider_key: 'fieldglass',
        external_event_id: eventId, external_req_id: 'VMS-IG', requisition_id: req,
        external_event_at: '2026-08-27T11:00:00.000Z', raw_provider_status: 'Reviewing',
      });
      expect(result.outcome).toBe('IGNORED');
      expect(await statusOf(req)).toBe('open'); // no mutation
      const recon = await db.query(
        `SELECT 1 FROM integration."RequisitionExternalReconciliation" WHERE connection_id=$1 AND external_event_id=$2`,
        [conn, eventId],
      );
      expect(recon.rowCount).toBe(0); // no reconciliation row
    });

    it('#11 — an unmapped provider state routes to reconciliation (no mutation)', async () => {
      const conn = await seedConnection(TENANT_A);
      const req = await seedReq(TENANT_A, 'open');
      await activateSingle(TENANT_A, conn, 'closed', 'CLOSE'); // active set has ONLY 'closed'
      const eventId = uuid();
      const result = await reconciler.ingest({
        tenant_id: TENANT_A, connection_id: conn, provider_key: 'fieldglass',
        external_event_id: eventId, external_req_id: 'VMS-UN', requisition_id: req,
        external_event_at: '2026-08-27T12:00:00.000Z', raw_provider_status: 'some_new_state',
      });
      expect(result.outcome).toBe('RECONCILED');
      expect(await statusOf(req)).toBe('open');
    });

    it('#9/#10 — service REJECTS EXECUTE with a non-allowed action and IGNORE carrying an action', async () => {
      const conn = await seedConnection(TENANT_A);
      await expect(
        admin.createDraft(TENANT_A, conn, ACTOR, [
          { provider_state: 'x', disposition: MAPPING_DISPOSITION.EXECUTE_ACTION, mapped_action: 'APPROVE' },
        ]),
      ).rejects.toMatchObject({ code: 'MAPPING_SET_INVALID' });
      await expect(
        admin.createDraft(TENANT_A, conn, ACTOR, [
          { provider_state: 'y', disposition: MAPPING_DISPOSITION.IGNORE, mapped_action: 'CLOSE' },
        ]),
      ).rejects.toMatchObject({ code: 'MAPPING_SET_INVALID' });
    });

    it('#9 (DB backstop) — the R4 CHECK rejects an illegal (disposition, mapped_action) at the row', async () => {
      const conn = await seedConnection(TENANT_A);
      // create a draft set directly, then attempt a raw illegal insert
      const draft = await admin.createDraft(TENANT_A, conn, ACTOR, []);
      const setId = (
        await db.query(
          `SELECT id FROM integration."RequisitionLifecycleMappingSet" WHERE connection_id=$1 AND version=$2`,
          [conn, draft.version],
        )
      ).rows[0].id;
      await expect(
        db.query(
          `INSERT INTO integration."RequisitionLifecycleMapping"
             (id, tenant_id, connection_id, mapping_set_id, provider_state, disposition, mapped_action, mapping_version, authority_mode, created_at, updated_at)
           VALUES (gen_random_uuid(),$1,$2,$3,'bad','EXECUTE_ACTION','APPROVE',1,'external_authority', now(), now())`,
          [TENANT_A, conn, setId],
        ),
      ).rejects.toThrow(/check/i);
    });

    it('#13/#14 — admin authoring writes external_authority only; a pre-existing dual_control row is preserved', async () => {
      const conn = await seedConnection(TENANT_A);
      await activateSingle(TENANT_A, conn, 'closed', 'CLOSE');
      // authored row is external_authority (R5)
      expect((await mappings.findByConnectionState(TENANT_A, conn, 'closed'))?.authority_mode).toBe('external_authority');
      // a pre-existing dual_control row (seeded via the compat path) is preserved + read honestly
      await mappings.upsertMapping({
        tenant_id: TENANT_A, connection_id: conn, provider_state: 'held',
        mapped_action: 'PUT_ON_HOLD', authority_mode: 'dual_control',
      });
      expect((await mappings.findByConnectionState(TENANT_A, conn, 'held'))?.authority_mode).toBe('dual_control');
    });

    it('#4 (guard) — one-active partial unique index forbids two active sets on a connection (raw)', async () => {
      const conn = await seedConnection(TENANT_A);
      await activateSingle(TENANT_A, conn, 'closed', 'CLOSE'); // one active exists
      await expect(
        db.query(
          `INSERT INTO integration."RequisitionLifecycleMappingSet" (id, tenant_id, connection_id, version, status, created_by)
           VALUES (gen_random_uuid(),$1,$2,999,'active',$3)`,
          [TENANT_A, conn, ACTOR],
        ),
      ).rejects.toThrow();
    });
  },
);
