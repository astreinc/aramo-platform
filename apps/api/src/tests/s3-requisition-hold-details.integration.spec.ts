import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RequisitionPrismaService,
  RequisitionRepository,
  RequisitionTransitionPolicyService,
} from '@aramo/requisition';
import { PolicyStore, PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';
import { deriveCapacity } from '@aramo/placement';

import { SEE_ALL_VISIBILITY } from './support/see-all-visibility.js';
import { publishLifecyclePackage } from './publish-lifecycle-package.js';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 LOCKED §6.6 (S3, A1 AM-3) — hold details,
// on REAL Postgres 17, through the real RequisitionRepository + the real transition policy.
//   Manual:    with details → event row + projection; missing reason / source → 400; 'vms' on
//              the manual path → 400; hold on CLOSE → 400; a status-only editor can hold.
//   VMS:       a seam hold with no reason → accepted, reason_provided:false; provider status
//              joined when the provenance row exists, and the display does not depend on it.
//   Legacy:    a hold placed before the amendment reads "not recorded" (recorded:false).
//   Isolation: another tenant's requisition is refused (404) and is not mutated.
//   DB floor:  the CHECKs refuse an on_hold transition event without a source, an empty reason,
//              and hold details on a non-hold event.

const ROOT = resolve(__dirname, '../../../..');
const TENANT = '01900000-0000-7000-8000-0000000003e1';
const OTHER_TENANT = '01900000-0000-7000-8000-0000000003e2';
const ACTOR = '01900000-0000-7000-8000-000000003a01';
const COMPANY = '01900000-0000-7000-8000-0000000003f1';

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = [...migrationsFor('requisition'), ...migrationsFor('policy-store')];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'S3 — requisition hold details (v1.2 §6; real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: RequisitionPrismaService;
    let storePrisma: PolicyStorePrismaService;
    let repo: RequisitionRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      // The provider-provenance table the detail read joins (integration schema). Only the
      // columns the join reads — this spec is not the integration substrate's subject.
      await db.query(`CREATE SCHEMA IF NOT EXISTS integration`);
      await db.query(
        `CREATE TABLE integration."RequisitionExternalTransitionProvenance" (
           id uuid PRIMARY KEY, tenant_id uuid NOT NULL, lifecycle_event_id uuid NOT NULL,
           raw_provider_status text NOT NULL)`,
      );
      await publishLifecyclePackage(url, TENANT);
      await publishLifecyclePackage(url, OTHER_TENANT);
      prisma = new RequisitionPrismaService(url);
      await prisma.$connect();
      storePrisma = new PolicyStorePrismaService(url);
      await storePrisma.$connect();
      const capacityStub = {
        projectCapacity: async (_t: string, _r: string, openings: number) =>
          deriveCapacity({ openings, consuming_count: 0 }),
        countActiveByRequisitionIds: async () => new Map<string, number>(),
      } as never;
      repo = new RequisitionRepository(
        prisma,
        {} as never,
        new RequisitionTransitionPolicyService(new PolicyStore(storePrisma)),
        capacityStub,
        { deriveByRequisitionIds: async () => new Map() } as never,
      );
    }, 180_000);

    afterAll(async () => {
      await prisma?.onModuleDestroy();
      await storePrisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
    }, 60_000);

    async function openReq(tenant = TENANT): Promise<string> {
      const view = await repo.create({
        tenant_id: tenant,
        entered_by_id: ACTOR,
        input: { title: 'S3 hold fixture', company_id: COMPANY, status: 'open' } as never,
        scopes: ['requisition:import:write'],
        creation_mode: 'INTEGRATION',
        requestId: uuidv7(),
      });
      return view.id;
    }
    function patch(id: string, input: Record<string, unknown>, scopes: string[] = ['requisition:edit'], tenant = TENANT) {
      return repo.update({
        visibility: SEE_ALL_VISIBILITY,
        tenant_id: tenant,
        id,
        input: input as never,
        scopes,
        actor_id: ACTOR,
        requestId: uuidv7(),
      });
    }
    async function refusal(p: Promise<unknown>): Promise<{ code?: string; status?: number; reason?: unknown }> {
      try {
        await p;
        return { code: 'NO_THROW' };
      } catch (e) {
        const x = e as { code?: string; statusCode?: number; context?: { details?: { reason?: unknown } } };
        return { code: x.code, status: x.statusCode, reason: x.context?.details?.reason };
      }
    }
    async function rowOf(id: string): Promise<{ status: string; version: number }> {
      return (await db.query(`SELECT status::text, version FROM requisition."Requisition" WHERE id=$1`, [id])).rows[0];
    }
    async function holdEvents(id: string) {
      return (
        await db.query(
          `SELECT id, hold_reason, hold_source, hold_effective_at, hold_instructions
             FROM requisition."RequisitionLifecycleEvent"
            WHERE requisition_id=$1 AND next_status='on_hold' ORDER BY occurred_at`,
          [id],
        )
      ).rows as Array<{ id: string; hold_reason: string | null; hold_source: string | null; hold_effective_at: Date | null; hold_instructions: string | null }>;
    }
    const detail = (id: string, tenant = TENANT) =>
      repo.findByIdForActor({ tenant_id: tenant, id, visibility: SEE_ALL_VISIBILITY });

    // ---- Manual (§6.2) -----------------------------------------------------------------------
    it('a manual hold with details writes them on the event row and projects them on the detail read', async () => {
      const id = await openReq();
      await patch(id, {
        status: 'on_hold',
        version: 0,
        hold: {
          reason: 'Client hiring temporarily paused',
          source: 'client',
          effective_at: '2026-10-21T00:00:00.000Z',
          instructions: 'Keep qualifying; no client submittals.',
        },
      });
      const [ev] = await holdEvents(id);
      expect(ev).toMatchObject({
        hold_reason: 'Client hiring temporarily paused',
        hold_source: 'client',
        hold_instructions: 'Keep qualifying; no client submittals.',
      });
      expect(ev!.hold_effective_at?.toISOString()).toBe('2026-10-21T00:00:00.000Z');
      const view = await detail(id);
      expect(view?.hold).toEqual({
        recorded: true,
        reason: 'Client hiring temporarily paused',
        reason_provided: true,
        source: 'client',
        effective_at: '2026-10-21T00:00:00.000Z',
        instructions: 'Keep qualifying; no client submittals.',
        provider_status: null,
      });
    });

    it('effective_at defaults to now; blank instructions are stored as null', async () => {
      const id = await openReq();
      const before = Date.now();
      await patch(id, { status: 'on_hold', version: 0, hold: { reason: 'Budget review', source: 'internal', instructions: '  ' } });
      const [ev] = await holdEvents(id);
      expect(ev!.hold_source).toBe('internal');
      expect(ev!.hold_instructions).toBeNull();
      expect(ev!.hold_effective_at!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    });

    for (const [label, hold] of [
      ['no hold details at all', undefined],
      ['a missing reason', { source: 'client' }],
      ['a blank reason', { reason: '   ', source: 'client' }],
      ['a missing source', { reason: 'Paused' }],
    ] as const) {
      it(`PUT_ON_HOLD with ${label} → 400 hold_details_required; nothing changes`, async () => {
        const id = await openReq();
        const r = await refusal(patch(id, { status: 'on_hold', version: 0, ...(hold === undefined ? {} : { hold }) }));
        expect(r).toEqual({ code: 'VALIDATION_ERROR', status: 400, reason: 'hold_details_required' });
        expect(await rowOf(id)).toEqual({ status: 'open', version: 0 });
        expect(await holdEvents(id)).toHaveLength(0);
      });
    }

    it("source 'vms' on the manual path → 400 (only the integration seam records vms)", async () => {
      const id = await openReq();
      const r = await refusal(patch(id, { status: 'on_hold', version: 0, hold: { reason: 'Paused', source: 'vms' } }));
      expect(r).toEqual({ code: 'VALIDATION_ERROR', status: 400, reason: 'hold_source_not_allowed' });
      expect(await rowOf(id)).toEqual({ status: 'open', version: 0 });
    });

    it('hold details on CLOSE → 400 hold_details_not_applicable; nothing changes', async () => {
      const id = await openReq();
      const r = await refusal(patch(id, { status: 'closed', version: 0, hold: { reason: 'x', source: 'client' } }));
      expect(r).toEqual({ code: 'VALIDATION_ERROR', status: 400, reason: 'hold_details_not_applicable' });
      expect(await rowOf(id)).toEqual({ status: 'open', version: 0 });
    });

    it('hold details on a non-status edit → 400 hold_details_not_applicable', async () => {
      const id = await openReq();
      const r = await refusal(patch(id, { title: 'renamed', hold: { reason: 'x', source: 'client' } }));
      expect(r.reason).toBe('hold_details_not_applicable');
    });

    it('a status-only editor (requisition:edit:status) can put a requisition on hold with details', async () => {
      const id = await openReq();
      await patch(
        id,
        { status: 'on_hold', version: 0, hold: { reason: 'Client paused', source: 'client' } },
        ['requisition:edit:status'],
      );
      expect((await rowOf(id)).status).toBe('on_hold');
      expect((await holdEvents(id))[0]).toMatchObject({ hold_reason: 'Client paused', hold_source: 'client' });
    });

    it('each hold keeps its own history; the projection shows the newest hold', async () => {
      const id = await openReq();
      await patch(id, { status: 'on_hold', version: 0, hold: { reason: 'First pause', source: 'client' } });
      await patch(id, { status: 'open', version: 1 });
      await patch(id, { status: 'on_hold', version: 2, hold: { reason: 'Second pause', source: 'internal' } });
      expect((await holdEvents(id)).map((e) => e.hold_reason)).toEqual(['First pause', 'Second pause']);
      expect((await detail(id))?.hold).toMatchObject({ reason: 'Second pause', source: 'internal' });
    });

    it('the hold projection is null once the requisition is no longer on hold', async () => {
      const id = await openReq();
      await patch(id, { status: 'on_hold', version: 0, hold: { reason: 'Paused', source: 'client' } });
      await patch(id, { status: 'open', version: 1 });
      expect((await detail(id))?.hold).toBeNull();
    });

    // ---- VMS (§6.3) --------------------------------------------------------------------------
    function vmsHold(id: string, eventAt: string) {
      return repo.executeExternalLifecycleCommand({
        tenant_id: TENANT,
        requisition_id: id,
        action: 'PUT_ON_HOLD',
        actor_id: ACTOR,
        origin: 'integration',
        external_provenance: {
          connection_id: uuidv7(),
          external_event_id: uuidv7(),
          external_event_at: eventAt,
          raw_provider_status: 'Halted',
          normalized_status: 'halted',
          mapping_version: 1,
          mapped_action: 'PUT_ON_HOLD',
        },
      });
    }

    it('a VMS hold with no provider reason is ACCEPTED: source vms, reason NULL, effective_at = external_event_at', async () => {
      const id = await openReq();
      const result = await vmsHold(id, '2026-10-20T15:30:00.000Z');
      expect(result).toMatchObject({ outcome: 'EXECUTED', next_status: 'on_hold' });
      const [ev] = await holdEvents(id);
      expect(ev).toMatchObject({ hold_source: 'vms', hold_reason: null, hold_instructions: null });
      expect(ev!.hold_effective_at?.toISOString()).toBe('2026-10-20T15:30:00.000Z');
      // The display does not depend on the provenance row (written after commit, §13 PE-3).
      expect((await detail(id))?.hold).toEqual({
        recorded: true,
        reason: null,
        reason_provided: false,
        source: 'vms',
        effective_at: '2026-10-20T15:30:00.000Z',
        instructions: null,
        provider_status: null,
      });
    });

    it('the provider status is shown once the provenance row links to the hold event', async () => {
      const id = await openReq();
      const result = await vmsHold(id, '2026-10-20T16:00:00.000Z');
      if (result.outcome !== 'EXECUTED') throw new Error('expected EXECUTED');
      await db.query(
        `INSERT INTO integration."RequisitionExternalTransitionProvenance" (id, tenant_id, lifecycle_event_id, raw_provider_status)
         VALUES ($1,$2,$3,'Halted')`,
        [uuidv7(), TENANT, result.lifecycle_event_id],
      );
      expect((await detail(id))?.hold).toMatchObject({ source: 'vms', reason_provided: false, provider_status: 'Halted' });
    });

    // ---- Legacy (A1 §4) ----------------------------------------------------------------------
    it('a hold placed before the amendment reads "not recorded" (recorded:false; nothing invented)', async () => {
      const id = await openReq();
      // A pre-amendment hold: the status + an on_hold event with no hold columns. Inserted with
      // the NOT VALID constraint bypassed exactly as historical rows were (they predate it).
      await db.query(`UPDATE requisition."Requisition" SET status='on_hold' WHERE id=$1`, [id]);
      await db.query(`ALTER TABLE requisition."RequisitionLifecycleEvent" DROP CONSTRAINT "RequisitionLifecycleEvent_hold_required_chk"`);
      try {
        await db.query(
          `INSERT INTO requisition."RequisitionLifecycleEvent"
             (id, tenant_id, requisition_id, previous_status, next_status, actor_id, origin, reason_code, correlation_id)
           VALUES ($1,$2,$3,'open','on_hold',$4,'ui','REQUISITION_STATUS_CHANGED',$5)`,
          [uuidv7(), TENANT, id, ACTOR, uuidv7()],
        );
      } finally {
        await db.query(
          `ALTER TABLE requisition."RequisitionLifecycleEvent" ADD CONSTRAINT "RequisitionLifecycleEvent_hold_required_chk"
             CHECK ("next_status"::text IS DISTINCT FROM 'on_hold' OR "previous_status" IS NULL
                    OR ("hold_source" IS NOT NULL AND ("hold_reason" IS NOT NULL OR "hold_source" = 'vms'))) NOT VALID`,
        );
      }
      expect((await detail(id))?.hold).toEqual({
        recorded: false,
        reason: null,
        reason_provided: false,
        source: null,
        effective_at: null,
        instructions: null,
        provider_status: null,
      });
    });

    it('a requisition ESTABLISHED on_hold (import; no hold action) is accepted and reads "not recorded" (DV-S3-1)', async () => {
      const view = await repo.create({
        tenant_id: TENANT,
        entered_by_id: ACTOR,
        input: { title: 'Imported on hold', company_id: COMPANY, status: 'on_hold' } as never,
        scopes: ['requisition:import:write'],
        creation_mode: 'INTEGRATION',
        requestId: uuidv7(),
      });
      expect(view.status).toBe('on_hold');
      expect((await detail(view.id))?.hold).toMatchObject({ recorded: false });
    });

    // ---- Isolation ---------------------------------------------------------------------------
    it("another tenant's requisition is refused (404) and is not mutated", async () => {
      const foreign = await openReq(OTHER_TENANT);
      const r = await refusal(patch(foreign, { status: 'on_hold', version: 0, hold: { reason: 'x', source: 'client' } }));
      expect(r.status).toBe(404);
      expect(await rowOf(foreign)).toEqual({ status: 'open', version: 0 });
      expect(await holdEvents(foreign)).toHaveLength(0);
      expect(await detail(foreign)).toBeNull();
    });

    // ---- DB floor (§6.1) ---------------------------------------------------------------------
    describe('the DB CHECKs (ADD-only floor)', () => {
      const insert = (cols: Record<string, unknown>) => {
        const base: Record<string, unknown> = {
          id: uuidv7(), tenant_id: TENANT, requisition_id: uuidv7(), previous_status: 'open', next_status: 'on_hold',
          actor_id: ACTOR, origin: 'ui', reason_code: 'REQUISITION_STATUS_CHANGED', correlation_id: uuidv7(),
        };
        const row = { ...base, ...cols };
        const keys = Object.keys(row);
        return db.query(
          `INSERT INTO requisition."RequisitionLifecycleEvent" (${keys.map((k) => `"${k}"`).join(',')})
           VALUES (${keys.map((k, i) => (k.endsWith('_status') ? `$${i + 1}::requisition."RecruitingStatus"` : `$${i + 1}`)).join(',')})`,
          keys.map((k) => row[k]),
        );
      };
      it('an on_hold transition event with no source is refused', async () => {
        await expect(insert({})).rejects.toThrow(/hold_required_chk/);
      });
      it('a manual source with no reason is refused; a vms source with no reason is allowed', async () => {
        await expect(insert({ hold_source: 'client' })).rejects.toThrow(/hold_required_chk/);
        await expect(insert({ hold_source: 'vms', hold_effective_at: new Date() })).resolves.toBeDefined();
      });
      it('an empty reason is refused', async () => {
        await expect(insert({ hold_source: 'client', hold_reason: '  ' })).rejects.toThrow(/hold_reason_nonempty_chk/);
      });
      it('an unknown source is refused', async () => {
        await expect(insert({ hold_source: 'email', hold_reason: 'x' })).rejects.toThrow(/hold_source_chk/);
      });
      it('hold details on a non-hold event are refused', async () => {
        await expect(insert({ next_status: 'closed', hold_source: 'client', hold_reason: 'x' })).rejects.toThrow(/hold_only_on_hold_chk/);
      });
    });
  },
);
