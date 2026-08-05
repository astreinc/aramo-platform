import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TenantResetService,
  ResetBatchStore,
  PrismaService,
  FileArchiveSink,
  RerunRefusedError,
  TenantAssertionError,
  type PgExec,
  type ArchivePayload,
} from '@aramo/tenant-reset';

// Track-0 (Tenant Reset & Archive, Directive v1.0 LOCKED §6) — the reset
// engine + the append-only ResetBatch store against real Postgres 17. NO
// Nest boot — the service takes a raw PgExec + a ResetBatchStore. Applies
// every repo migration (so all requisition-domain tables AND the new
// tenant_reset.ResetBatch table EXIST), seeds ONE target tenant with the
// full requisition workflow + the preserved surfaces + a SECOND bystander
// tenant, and proves the directive's trust properties:
//   - dry run mutates NOTHING (every row count unchanged);
//   - a wrong tenant id refuses with no partial work;
//   - execute deletes the §2.2 workflow scope exactly, in order;
//   - every preserved entity's count is identical before and after;
//   - Activity is a SCOPED purge — talent/company/contact history survives;
//   - the SECOND tenant is entirely untouched (tenant isolation);
//   - RequisitionLifecycleEvent is exported (in the archive) then deleted;
//   - the archive is written + checksum-verified; a ResetBatch is recorded;
//   - a re-run after a completed batch is refused, not repeated.

const ROOT = resolve(__dirname, '../../../..');

async function allMigrations(db: Client): Promise<void> {
  const { readdirSync } = await import('node:fs');
  const libs = resolve(ROOT, 'libs');
  const out: Array<{ ts: string; path: string }> = [];
  for (const lib of readdirSync(libs)) {
    const migDir = resolve(libs, lib, 'prisma', 'migrations');
    let entries: string[];
    try {
      entries = readdirSync(migDir);
    } catch {
      continue;
    }
    for (const d of entries) {
      const file = resolve(migDir, d, 'migration.sql');
      try {
        readFileSync(file);
      } catch {
        continue;
      }
      out.push({ ts: d, path: file });
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (const o of out) await db.query(readFileSync(o.path, 'utf8'));
}

// Target tenant (reset) and a bystander tenant (must be untouched).
const T = '01900000-0000-7000-8000-0000000000a1';
const T2 = '01900000-0000-7000-8000-0000000000b1';
const REQ1 = '01900000-0000-7000-8000-0000000000a2';
const REQ2 = '01900000-0000-7000-8000-0000000000a3';
const REQ_B = '01900000-0000-7000-8000-0000000000b2';
const PIPE = '01900000-0000-7000-8000-0000000000a4';
const PIPE_B = '01900000-0000-7000-8000-0000000000b3';
const TALENT = '01900000-0000-7000-8000-0000000000a5';
const TALENT_B = '01900000-0000-7000-8000-0000000000b4';
const COMPANY = '01900000-0000-7000-8000-0000000000a6';
const CONTACT = '01900000-0000-7000-8000-0000000000a7';
const ENG = '01900000-0000-7000-8000-0000000000a8';
const SUB = '01900000-0000-7000-8000-0000000000a9';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Track-0 — tenant-reset engine (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let pg: PgExec;
    let store: ResetBatchStore;
    let prisma: PrismaService;
    let svc: TenantResetService;
    let archiveDir: string;

    async function count(table: string, where: string, params: unknown[]): Promise<number> {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
        params,
      );
      return Number(r.rows[0]!.n);
    }

    // Per-tenant counts across the five E2 pre-start tables.
    async function countE2(tenant: string): Promise<Record<'set' | 'def' | 'inst' | 'intent' | 'audit', number>> {
      const w = 'tenant_id=$1::uuid';
      return {
        set: await count('pre_start_requirement."PreStartRequirementSet"', w, [tenant]),
        def: await count('pre_start_requirement."PreStartRequirementDefinition"', w, [tenant]),
        inst: await count('pre_start_requirement."PreStartRequirementInstance"', w, [tenant]),
        intent: await count('pre_start_requirement."PreStartMaterializationIntent"', w, [tenant]),
        audit: await count('pre_start_requirement."PreStartRequirementAudit"', w, [tenant]),
      };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const uri = container.getConnectionUri();
      db = new Client({ connectionString: uri });
      await db.connect();
      await allMigrations(db);

      pg = {
        async query<T2v>(sql: string, ps?: unknown[]) {
          const r = await db.query(sql, ps as unknown[] | undefined);
          return { rows: r.rows as T2v[], rowCount: r.rowCount };
        },
      };
      prisma = new PrismaService(uri);
      store = new ResetBatchStore(prisma);
      svc = new TenantResetService(store, new FileArchiveSink());
      archiveDir = mkdtempSync(resolve(tmpdir(), 'aramo-reset-'));

      // ---- Seed two tenants -------------------------------------------
      for (const [id, name] of [
        [T, 'Target Co'],
        [T2, 'Bystander Co'],
      ] as const) {
        await db.query(
          `INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid,$2,now())`,
          [id, name],
        );
      }
      for (const [id, tenant] of [
        [TALENT, T],
        [TALENT_B, T2],
      ] as const) {
        await db.query(
          `INSERT INTO talent_record."TalentRecord" (id, tenant_id, first_name, last_name) VALUES ($1::uuid,$2::uuid,'Grace','Hopper')`,
          [id, tenant],
        );
      }
      await db.query(
        `INSERT INTO company."Company" (id, tenant_id, name) VALUES ($1::uuid,$2::uuid,'Acme')`,
        [COMPANY, T],
      );
      await db.query(
        `INSERT INTO contact."Contact" (id, tenant_id, company_id, first_name, last_name) VALUES ($1::uuid,$2::uuid,$3::uuid,'Ada','Byron')`,
        [CONTACT, T, COMPANY],
      );

      // Requisitions: two for T, one for the bystander.
      for (const [id, tenant] of [
        [REQ1, T],
        [REQ2, T],
        [REQ_B, T2],
      ] as const) {
        await db.query(
          `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, requisition_number) VALUES ($1::uuid,$2::uuid,'Engineer',$3::uuid, (SELECT COALESCE(MAX(rn.requisition_number),999)+1 FROM requisition."Requisition" rn WHERE rn.tenant_id = $2::uuid))`,
          [id, tenant, COMPANY],
        );
      }
      // Requisition assignment (cascade child of REQ1).
      await db.query(
        `INSERT INTO requisition."RequisitionAssignment" (id, tenant_id, requisition_id, user_id) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
        [uuidv7(), T, REQ1, uuidv7()],
      );
      // Requisition lifecycle event (bare-UUID history — must be exported then deleted).
      await db.query(
        `INSERT INTO requisition."RequisitionLifecycleEvent"
           (id, tenant_id, requisition_id, previous_status, next_status, actor_id, origin, reason_code, correlation_id)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'open','on_hold','actor-1','ui','MANUAL_HOLD','corr-1')`,
        [uuidv7(), T, REQ1],
      );

      // Pipelines + status history (T and bystander).
      for (const [id, tenant, req, talent] of [
        [PIPE, T, REQ1, TALENT],
        [PIPE_B, T2, REQ_B, TALENT_B],
      ] as const) {
        await db.query(
          `INSERT INTO pipeline."Pipeline" (id, tenant_id, talent_record_id, requisition_id) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
          [id, tenant, talent, req],
        );
      }
      await db.query(
        `INSERT INTO pipeline."PipelineStatusHistory" (id, tenant_id, pipeline_id, status_from, status_to) VALUES ($1::uuid,$2::uuid,$3::uuid,'no_contact','contacted')`,
        [uuidv7(), T, PIPE],
      );

      // Engagement + event (T).
      await db.query(
        `INSERT INTO engagement."TalentJobEngagement" (id, tenant_id, talent_id, requisition_id) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
        [ENG, T, TALENT, REQ1],
      );
      await db.query(
        `INSERT INTO engagement."TalentEngagementEvent" (id, tenant_id, engagement_id, event_type, event_payload) VALUES ($1::uuid,$2::uuid,$3::uuid,'state_transition','{}'::jsonb)`,
        [uuidv7(), T, ENG],
      );
      // Submittal + event (T).
      await db.query(
        `INSERT INTO engagement."TalentSubmittalRecord" (id, tenant_id, talent_id, job_id, evidence_package_id, pinned_examination_id, created_by) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid)`,
        [SUB, T, TALENT, REQ1, uuidv7(), uuidv7(), uuidv7()],
      );
      await db.query(
        `INSERT INTO engagement."TalentSubmittalEvent" (id, tenant_id, submittal_id, event_type, event_payload) VALUES ($1::uuid,$2::uuid,$3::uuid,'state_transition','{}'::jsonb)`,
        [uuidv7(), T, SUB],
      );

      // Activity — the scoped-purge crux (§2.3): 2 workflow rows (DELETE) +
      // 3 talent/company/contact history rows (PRESERVE) for T, and 1
      // workflow row for the bystander (must SURVIVE — different tenant).
      const act = async (tenant: string, type: string, st: string | null, sid: string | null): Promise<void> => {
        await db.query(
          `INSERT INTO activity."Activity" (id, tenant_id, type, subject_type, subject_id) VALUES ($1::uuid,$2::uuid,$3::"activity"."ActivityType",$4,$5::uuid)`,
          [uuidv7(), tenant, type, st, sid],
        );
      };
      await act(T, 'pipeline_status_change', 'pipeline', PIPE); // workflow → delete
      await act(T, 'note', 'requisition', REQ1); // workflow → delete
      await act(T, 'call', 'talent_record', TALENT); // talent history → preserve
      await act(T, 'note', 'company', COMPANY); // company history → preserve
      await act(T, 'note', 'contact', CONTACT); // contact history → preserve
      await act(T2, 'pipeline_status_change', 'pipeline', PIPE_B); // bystander → survive

      // Metering (financial evidence — never deleted) + consent (preserved).
      for (const tenant of [T, T, T2]) {
        await db.query(
          `INSERT INTO metering."UsageEvent" (id, tenant_id, event_type) VALUES ($1::uuid,$2::uuid,'engagement.state_transition')`,
          [uuidv7(), tenant],
        );
      }
      await db.query(
        `INSERT INTO consent."TalentConsentEvent" (id, talent_record_id, tenant_id, scope, action, captured_method, consent_version, occurred_at) VALUES ($1::uuid,$2::uuid,$3::uuid,'profile_storage','granted','import','v1',now())`,
        [uuidv7(), TALENT, T],
      );

      // ---- E2 pre-start requirement chain (T0 v1.1 §2.2.7) — one full chain
      // per tenant: Set → Definition → Instance → Audit + MaterializationIntent.
      // T's rows are deleted by the reset (via the reset-marker escape for the
      // trigger-protected Instance/Audit); T2's must survive.
      const seedE2 = async (tenant: string): Promise<void> => {
        const setId = uuidv7();
        const defId = uuidv7();
        const instId = uuidv7();
        const placementId = uuidv7();
        await db.query(
          `INSERT INTO pre_start_requirement."PreStartRequirementSet"
             (id, tenant_id, scope, scope_ref_id, version, state, checksum)
           VALUES ($1::uuid,$2::uuid,'TENANT',$2::uuid,'v1','published','deadbeef')`,
          [setId, tenant],
        );
        await db.query(
          `INSERT INTO pre_start_requirement."PreStartRequirementDefinition"
             (id, tenant_id, set_id, requirement_type, label, blocking, sequence, waiver_mode)
           VALUES ($1::uuid,$2::uuid,$3::uuid,'BACKGROUND_CHECK','Background check',true,1,'NOT_WAIVABLE')`,
          [defId, tenant, setId],
        );
        await db.query(
          `INSERT INTO pre_start_requirement."PreStartRequirementInstance"
             (id, tenant_id, placement_process_id, definition_set_id, definition_set_version,
              definition_set_checksum, requirement_definition_id, requirement_type, label, blocking,
              waiver_mode, status)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'v1','deadbeef',$5::uuid,'BACKGROUND_CHECK',
                   'Background check',true,'NOT_WAIVABLE','PENDING')`,
          [instId, tenant, placementId, setId, defId],
        );
        await db.query(
          `INSERT INTO pre_start_requirement."PreStartRequirementAudit"
             (id, tenant_id, requirement_instance_id, action, actor_id, actor_type, previous_status, resulting_status)
           VALUES ($1::uuid,$2::uuid,$3::uuid,'FAILED',$4::uuid,'system','PENDING','FAILED')`,
          [uuidv7(), tenant, instId, uuidv7()],
        );
        await db.query(
          `INSERT INTO pre_start_requirement."PreStartMaterializationIntent"
             (id, tenant_id, placement_process_id, scope, scope_ref_id, status)
           VALUES ($1::uuid,$2::uuid,$3::uuid,'TENANT',$2::uuid,'resolved')`,
          [uuidv7(), tenant, placementId],
        );
      };
      await seedE2(T);
      await seedE2(T2);
    }, 300_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    }, 60_000);

    const opts = (over: Record<string, unknown> = {}) => ({
      tenantId: T,
      approvedBy: 'Purush (PO)',
      executionCommit: 'test-sha',
      ...over,
    });

    // ---- (1) dry run: full plan, correct counts, ZERO mutations ----------
    it('(1) dry run counts the full §2.2 scope and writes NOTHING', async () => {
      const before = {
        req: await count('requisition."Requisition"', 'tenant_id=$1::uuid', [T]),
        pipe: await count('pipeline."Pipeline"', 'tenant_id=$1::uuid', [T]),
        act: await count('activity."Activity"', 'tenant_id=$1::uuid', [T]),
        usage: await count('metering."UsageEvent"', 'tenant_id=$1::uuid', [T]),
      };

      const report = await svc.dryRun(pg, opts());

      expect(report.mode).toBe('dry-run');
      expect(report.result).toBe('COMPLETED');
      expect(report.scope.requisition_ids.sort()).toEqual([REQ1, REQ2].sort());
      expect(report.scope.pipeline_ids).toEqual([PIPE]);

      const del = (label: string): number => report.deleted.find((d) => d.label === label)!.before;
      expect(del('activity."Activity"')).toBe(2); // ONLY the 2 workflow rows
      expect(del('requisition."RequisitionLifecycleEvent"')).toBe(1);
      expect(del('engagement."TalentSubmittalEvent"')).toBe(1);
      expect(del('engagement."TalentSubmittalRecord"')).toBe(1);
      expect(del('engagement."TalentEngagementEvent"')).toBe(1);
      expect(del('engagement."TalentJobEngagement"')).toBe(1);
      expect(del('pipeline."PipelineStatusHistory"')).toBe(1);
      expect(del('pipeline."Pipeline"')).toBe(1);
      expect(del('requisition."RequisitionAssignment"')).toBe(1);
      expect(del('requisition."Requisition"')).toBe(2);

      // ZERO mutations — every count unchanged, and no archive written.
      expect(await count('requisition."Requisition"', 'tenant_id=$1::uuid', [T])).toBe(before.req);
      expect(await count('pipeline."Pipeline"', 'tenant_id=$1::uuid', [T])).toBe(before.pipe);
      expect(await count('activity."Activity"', 'tenant_id=$1::uuid', [T])).toBe(before.act);
      expect(await count('metering."UsageEvent"', 'tenant_id=$1::uuid', [T])).toBe(before.usage);
      expect(report.archive_location).toBeNull();

      // A dry-run batch is recorded (§2.1).
      const batches = await store.listByTenant(T);
      expect(batches.some((b) => b.dry_run && b.result === 'COMPLETED')).toBe(true);
    });

    // ---- (2) wrong tenant id refuses, no partial work --------------------
    it('(2) a non-existent tenant id refuses with no partial work', async () => {
      const ghost = '01900000-0000-7000-8000-0000000000ff';
      await expect(
        svc.execute(pg, opts({ tenantId: ghost, archiveLocation: resolve(archiveDir, 'ghost.json') })),
      ).rejects.toBeInstanceOf(TenantAssertionError);
      expect(existsSync(resolve(archiveDir, 'ghost.json'))).toBe(false);
    });

    // ---- E2 dry-run proof: counts included, no DELETE, no marker leaked -----
    it('(E2-0) dry run includes E2 counts, mutates no E2 row, and leaks no marker', async () => {
      const before = await countE2(T);
      const report = await svc.dryRun(pg, opts());
      const del = (label: string): number => report.deleted.find((d) => d.label === label)?.before ?? -1;
      expect(del('pre_start_requirement."PreStartRequirementAudit"')).toBe(1);
      expect(del('pre_start_requirement."PreStartRequirementInstance"')).toBe(1);
      expect(del('pre_start_requirement."PreStartRequirementDefinition"')).toBe(1);
      expect(del('pre_start_requirement."PreStartMaterializationIntent"')).toBe(1);
      expect(del('pre_start_requirement."PreStartRequirementSet"')).toBe(1);
      // Dry-run issued NO delete and set NO marker: E2 rows unchanged, and an
      // ordinary DELETE is still rejected (no marker survived the dry-run).
      expect(await countE2(T)).toEqual(before);
      await expect(
        db.query(`DELETE FROM pre_start_requirement."PreStartRequirementAudit" WHERE tenant_id=$1::uuid`, [T]),
      ).rejects.toThrow(/not permitted/);
    });

    // ---- Six-part §2.4 proof, part 1: ordinary DELETE rejected BEFORE reset --
    it('(E2-1) an ordinary DELETE of a trigger-protected E2 row is rejected before the reset', async () => {
      await expect(
        db.query(`DELETE FROM pre_start_requirement."PreStartRequirementAudit" WHERE tenant_id=$1::uuid`, [T]),
      ).rejects.toThrow(/not permitted/);
      await expect(
        db.query(`DELETE FROM pre_start_requirement."PreStartRequirementInstance" WHERE tenant_id=$1::uuid`, [T]),
      ).rejects.toThrow(/not permitted/);
      expect((await countE2(T)).audit).toBe(1); // nothing deleted
    });

    // ---- (3) execute: scoped delete + preserve invariants + isolation ----
    it('(3) execute deletes the §2.2 scope, preserves everything else, isolates the bystander', async () => {
      // Snapshot the preserved surfaces (must be identical after).
      const preservedBefore = {
        usage: await count('metering."UsageEvent"', 'tenant_id=$1::uuid', [T]),
        consent: await count('consent."TalentConsentEvent"', 'tenant_id=$1::uuid', [T]),
        talent: await count('talent_record."TalentRecord"', 'tenant_id=$1::uuid', [T]),
        company: await count('company."Company"', 'tenant_id=$1::uuid', [T]),
        contact: await count('contact."Contact"', 'tenant_id=$1::uuid', [T]),
        tenantRow: await count('identity."Tenant"', 'id=$1::uuid', [T]),
        histActivity: await count(
          'activity."Activity"',
          `tenant_id=$1::uuid AND subject_type IN ('talent_record','company','contact')`,
          [T],
        ),
      };
      // Bystander snapshot.
      const bystanderBefore = {
        req: await count('requisition."Requisition"', 'tenant_id=$1::uuid', [T2]),
        pipe: await count('pipeline."Pipeline"', 'tenant_id=$1::uuid', [T2]),
        act: await count('activity."Activity"', 'tenant_id=$1::uuid', [T2]),
        usage: await count('metering."UsageEvent"', 'tenant_id=$1::uuid', [T2]),
      };

      const archiveLocation = resolve(archiveDir, 'reset-T.json');
      const report = await svc.execute(pg, opts({ archiveLocation }));

      expect(report.result).toBe('COMPLETED');
      expect(report.archive_verified).toBe(true);
      expect(report.freeze_engaged).toBe(true);
      expect(report.freeze_released).toBe(true);

      // Every §2.2 deleted entity is now zero for the tenant.
      expect(await count('requisition."Requisition"', 'tenant_id=$1::uuid', [T])).toBe(0);
      expect(await count('requisition."RequisitionAssignment"', 'tenant_id=$1::uuid', [T])).toBe(0);
      expect(await count('requisition."RequisitionLifecycleEvent"', 'tenant_id=$1::uuid', [T])).toBe(0);
      expect(await count('pipeline."Pipeline"', 'tenant_id=$1::uuid', [T])).toBe(0);
      expect(await count('pipeline."PipelineStatusHistory"', 'tenant_id=$1::uuid', [T])).toBe(0);
      expect(await count('engagement."TalentJobEngagement"', 'tenant_id=$1::uuid', [T])).toBe(0);
      expect(await count('engagement."TalentEngagementEvent"', 'tenant_id=$1::uuid', [T])).toBe(0);
      expect(await count('engagement."TalentSubmittalRecord"', 'tenant_id=$1::uuid', [T])).toBe(0);
      expect(await count('engagement."TalentSubmittalEvent"', 'tenant_id=$1::uuid', [T])).toBe(0);

      // Activity is a SCOPED purge — the 2 workflow rows go, the 3 history rows stay.
      expect(
        await count('activity."Activity"', `tenant_id=$1::uuid AND subject_type IN ('requisition','pipeline')`, [T]),
      ).toBe(0);
      expect(
        await count('activity."Activity"', `tenant_id=$1::uuid AND subject_type IN ('talent_record','company','contact')`, [T]),
      ).toBe(preservedBefore.histActivity);
      expect(preservedBefore.histActivity).toBe(3);

      // Every preserved entity is identical before and after.
      expect(await count('metering."UsageEvent"', 'tenant_id=$1::uuid', [T])).toBe(preservedBefore.usage);
      expect(await count('consent."TalentConsentEvent"', 'tenant_id=$1::uuid', [T])).toBe(preservedBefore.consent);
      expect(await count('talent_record."TalentRecord"', 'tenant_id=$1::uuid', [T])).toBe(preservedBefore.talent);
      expect(await count('company."Company"', 'tenant_id=$1::uuid', [T])).toBe(preservedBefore.company);
      expect(await count('contact."Contact"', 'tenant_id=$1::uuid', [T])).toBe(preservedBefore.contact);
      expect(await count('identity."Tenant"', 'id=$1::uuid', [T])).toBe(preservedBefore.tenantRow);

      // Bystander tenant is ENTIRELY untouched.
      expect(await count('requisition."Requisition"', 'tenant_id=$1::uuid', [T2])).toBe(bystanderBefore.req);
      expect(await count('pipeline."Pipeline"', 'tenant_id=$1::uuid', [T2])).toBe(bystanderBefore.pipe);
      expect(await count('activity."Activity"', 'tenant_id=$1::uuid', [T2])).toBe(bystanderBefore.act);
      expect(await count('metering."UsageEvent"', 'tenant_id=$1::uuid', [T2])).toBe(bystanderBefore.usage);

      // Orphan checks are all clean (deleted entities zero, no dangling usage).
      expect(report.orphan_checks.every((o) => o.remaining === 0)).toBe(true);

      // The archive was written and EXPORTED the lifecycle events BEFORE deletion.
      expect(existsSync(archiveLocation)).toBe(true);
      const archive = JSON.parse(readFileSync(archiveLocation, 'utf8')) as ArchivePayload;
      expect(archive.entities['requisition."RequisitionLifecycleEvent"']).toHaveLength(1);
      expect(archive.entities['requisition."Requisition"']).toHaveLength(2);
      expect(report.archive_checksum).toMatch(/^[0-9a-f]{64}$/);

      // A COMPLETED real-run batch is recorded (append-only), readable back.
      const real = await store.findCompletedRealRun(T);
      expect(real).not.toBeNull();
      expect(real!.execution_commit).toBe('test-sha');
      const full = await store.getById(T, real!.id);
      expect(full!.dry_run).toBe(false);
      expect(full!.archive_checksum).toBe(report.archive_checksum);
    });

    // ---- Six-part §2.4 proof, parts 2/3/4/5 — after the real reset ---------
    it('(E2-2) governed reset removed all of T\'s E2 rows via the escape; bystander survives; marker gone', async () => {
      // part 2 — the governed real reset (test 3, svc.execute) deleted every E2
      // row for T, including the trigger-protected Instance + Audit.
      expect(await countE2(T)).toEqual({ set: 0, def: 0, inst: 0, intent: 0, audit: 0 });
      // part 3 — the bystander tenant's E2 chain is entirely intact.
      expect(await countE2(T2)).toEqual({ set: 1, def: 1, inst: 1, intent: 1, audit: 1 });
      // parts 4 + 5 — the marker was transaction-local and did NOT persist past
      // commit: an ordinary DELETE of a surviving protected row is rejected again.
      await expect(
        db.query(`DELETE FROM pre_start_requirement."PreStartRequirementAudit" WHERE tenant_id=$1::uuid`, [T2]),
      ).rejects.toThrow(/not permitted/);
      await expect(
        db.query(`DELETE FROM pre_start_requirement."PreStartRequirementInstance" WHERE tenant_id=$1::uuid`, [T2]),
      ).rejects.toThrow(/not permitted/);
      expect((await countE2(T2)).audit).toBe(1); // still protected, nothing deleted
    });

    // ---- (4) re-run is refused, not repeated (§4) ------------------------
    it('(4) a re-run after a completed batch is refused, and proceeds only with override', async () => {
      await expect(
        svc.execute(pg, opts({ archiveLocation: resolve(archiveDir, 'again.json') })),
      ).rejects.toBeInstanceOf(RerunRefusedError);

      // With an explicit override + new approval it proceeds (and finds
      // nothing left to delete — idempotent).
      const report = await svc.execute(
        pg,
        opts({ archiveLocation: resolve(archiveDir, 'override.json'), overrideCompletedRun: true }),
      );
      expect(report.result).toBe('COMPLETED');
      expect(report.deleted.every((d) => d.before === 0)).toBe(true);
    });
  },
);
