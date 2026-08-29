import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { PrismaService } from '@aramo/submittal-eligibility';

// Lane L8-B1 (v1.2) — the load-bearing atomicity + authority proofs for the
// "Submit Talent to Client" orchestrator (real Postgres 17, 7 schemas). These
// are the six non-negotiable Gate-5 proofs:
//   P1  happy path — submitted_to_ats AUTHORITATIVE + pipeline submitted MIRROR
//   P2  concurrent submittal_limit=1 → exactly ONE commit / ONE consumption / ONE typed refusal
//   P3  forced failure AFTER submitted_to_ats, before the mirror completes →
//       ZERO durable rows across ALL participating schemas (strong atomicity)
//   P4  invalid link (null / identity-mismatch) → SUBMITTAL_PIPELINE_LINK_INVALID, no writes
//   P6  idempotent repeat → refused, slot consumed exactly once
// (P5 — the bare-pipeline `→ submitted` refusal + no-regression — lives lib-local
//  in libs/pipeline where PipelineRepository + its client are natural.)
//
// The forced-failure (P3) is injected by wrapping @aramo/activity's
// insertActivityInTx: it throws ONLY when the runtime flag is set, so P1/P2 use
// the real helper. The wrap runs INSIDE the orchestrator's one transaction, AFTER
// the authoritative submitted_to_ats write and the pipeline UPDATE — exactly the
// window the atomic guarantee must cover.

const failFlag = { fail: false };
vi.mock('@aramo/activity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aramo/activity')>();
  return {
    ...actual,
    insertActivityInTx: (...args: Parameters<typeof actual.insertActivityInTx>) => {
      if (failFlag.fail) {
        throw new Error('INJECTED failure after authoritative write, mid-mirror');
      }
      return actual.insertActivityInTx(...args);
    },
  };
});

// Imported AFTER the mock declaration so the orchestrator binds the wrapped helper.
const { SubmitTalentToClientService } = await import('../submit-talent/submit-talent.service.js');

const ROOT = resolve(__dirname, '../../../..');
const mig = (p: string): string => resolve(ROOT, p);
const MIGRATIONS = [
  'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
  // L1-C — the D6 submit gate reads requisition.status against the CANONICAL
  // RecruitingStatus enum ('open' / 'draft' / 'submittals_closed' / …). The init
  // migration above ships the superseded RequisitionStatus enum (active/full/…),
  // so the T1-d supersession migration is applied here to give the fixtures the
  // real lifecycle values. It is authored to run atop the requisition init alone
  // (its RequisitionLifecycleEvent alters are IF EXISTS) — see its header.
  'libs/requisition/prisma/migrations/20260803120000_recruiting_status_supersession/migration.sql',
  'libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
  'libs/pipeline/prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  'libs/pipeline/prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
  'libs/pipeline/prisma/migrations/20260827120000_l2a_pipeline_version_column/migration.sql',
  // L2-B — append-only history trigger; nullable status_from + ended_at/ended_by_id; pipeline OutboxEvent.
  'libs/pipeline/prisma/migrations/20260828100000_l2b_pipeline_history_append_only/migration.sql',
  'libs/pipeline/prisma/migrations/20260828110000_l2b_pipeline_ended_at_nullable_status_from/migration.sql',
  'libs/pipeline/prisma/migrations/20260828120000_l2b_pipeline_outbox_event/migration.sql',
  'libs/pipeline/prisma/migrations/20260828130000_l2c_pipeline_qualified_completed_enum/migration.sql',
  'libs/pipeline/prisma/migrations/20260828140000_l2c_pipeline_live_episode_recreate/migration.sql',
  'libs/pipeline/prisma/migrations/20260828150000_l2c_pipeline_disposition/migration.sql',
  'libs/pipeline/prisma/migrations/20260828160000_l2d_pipeline_entry_provenance/migration.sql',
  'libs/submittal/prisma/migrations/20260523120000_init_submittal_model/migration.sql',
  'libs/submittal/prisma/migrations/20260523200000_add_submittal_revoke/migration.sql',
  'libs/submittal/prisma/migrations/20260526140602_add_submittal_event_log/migration.sql',
  'libs/submittal/prisma/migrations/20260527000000_rename_submittal_state_canonical/migration.sql',
  'libs/submittal/prisma/migrations/20260531000000_add_outbox_event/migration.sql',
  'libs/submittal/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
  'libs/submittal/prisma/migrations/20260812120000_t2p1_relocate_submittal_to_submittal_schema/migration.sql',
  'libs/submittal/prisma/migrations/20260822130000_l8b1_submittal_pipeline_link/migration.sql',
  'libs/client-talent-restriction/prisma/migrations/20260803163000_init_client_talent_restriction_model/migration.sql',
  'libs/submittal-eligibility/prisma/migrations/20260822120000_init_submittal_eligibility_model/migration.sql',
].map(mig);

const logger = { log: () => undefined, error: () => undefined, warn: () => undefined } as never;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L8-B1 Submit-Talent-to-Client orchestrator — atomicity + authority (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let sql: Client;
    let db: PrismaService;
    let svc: InstanceType<typeof SubmitTalentToClientService>;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      sql = new Client({ connectionString: url });
      await sql.connect();
      // pg's native multi-statement query is comment-safe (no splitDdl trap).
      for (const p of MIGRATIONS) await sql.query(readFileSync(p, 'utf8'));
      db = new PrismaService(url);
      await db.$connect();
      svc = new SubmitTalentToClientService(db, logger);
    }, 180_000);

    afterAll(async () => {
      await db?.$disconnect();
      await sql?.end();
      await container?.stop();
    });

    beforeEach(() => {
      failFlag.fail = false;
    });

    // ---- seed + count helpers (raw SQL, so any schema is reachable) ----------
    async function seedPipeline(t: string, id: string, talent: string, req: string, status = 'qualifying'): Promise<void> {
      await sql.query(
        `INSERT INTO pipeline."Pipeline" (id,tenant_id,talent_record_id,requisition_id,status)
         VALUES ($1,$2,$3,$4,$5::pipeline."PipelineStatus")`,
        [id, t, talent, req, status],
      );
    }
    async function seedSubmittal(t: string, id: string, talent: string, job: string, pipelineId: string | null, state = 'ready_for_review'): Promise<void> {
      await sql.query(
        `INSERT INTO submittal."TalentSubmittalRecord"
           (id,tenant_id,talent_id,job_id,evidence_package_id,pinned_examination_id,state,created_by,pipeline_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::submittal."SubmittalState",$8,$9)`,
        [id, t, talent, job, randomUUID(), randomUUID(), state, randomUUID(), pipelineId],
      );
    }
    // L1-C — seed the requisition the submit gate now reads. A raw-SQL insert
    // (the spec runs against curated migrations, NOT the Nest app, so it cannot
    // use establishOpenRequisition). status defaults to 'open' — the only value
    // the gate admits — so the pre-L1-C fixtures pass the new gate unchanged.
    async function seedRequisition(t: string, req: string, status = 'open'): Promise<void> {
      await sql.query(
        `INSERT INTO requisition."Requisition" (id,tenant_id,title,company_id,status)
         VALUES ($1,$2,'L1-C fixture',$3,$4::requisition."RecruitingStatus")`,
        [req, t, randomUUID(), status],
      );
    }
    async function seedPolicy(t: string, req: string, limit: number | null): Promise<void> {
      await sql.query(
        `INSERT INTO submittal_policy."RequisitionSubmittalPolicy"
           (tenant_id,requisition_id,submittal_limit,submittal_authority,updated_at)
         VALUES ($1,$2,$3,'ARAMO',NOW())`,
        [t, req, limit],
      );
    }
    const one = async (q: string, v: unknown[]): Promise<string> =>
      (await sql.query<{ c: string }>(q, v)).rows[0]!.c;
    const submittalState = (id: string) =>
      one(`SELECT state::text || '|' || (confirmed_at IS NOT NULL)::text AS c FROM submittal."TalentSubmittalRecord" WHERE id=$1`, [id]);
    const pipelineStatus = (id: string) =>
      one(`SELECT status::text AS c FROM pipeline."Pipeline" WHERE id=$1`, [id]);
    const requisitionStatus = (id: string) =>
      one(`SELECT status::text AS c FROM requisition."Requisition" WHERE id=$1`, [id]);
    const count = (table: string, where: string, v: unknown[]) =>
      one(`SELECT count(*)::text AS c FROM ${table} WHERE ${where}`, v);

    // ---- P1: happy path — authoritative fact + mirror --------------------------
    it('P1 happy path: submitted_to_ats is AUTHORITATIVE and pipeline submitted is the MIRROR', async () => {
      const t = randomUUID(), talent = randomUUID(), req = randomUUID();
      const pipe = randomUUID(), sub = randomUUID();
      await seedRequisition(t, req, 'open'); // L1-C proof 6 — open requisition → the submit SUCCEEDS.
      await seedPipeline(t, pipe, talent, req);
      await seedSubmittal(t, sub, talent, req, pipe);

      // BEFORE
      expect(await submittalState(sub)).toBe('ready_for_review|false');
      expect(await pipelineStatus(pipe)).toBe('qualifying');
      expect(await count('submittal_policy."SubmittalConsumption"', 'requisition_id=$1', [req])).toBe('0');

      const res = await svc.submitToClient({ tenant_id: t, submittal_id: sub, event_id: randomUUID(), actor_id: randomUUID(), requestId: 'p1' });
      expect(res).toEqual({ submittal_id: sub, pipeline_id: pipe, state: 'submitted_to_ats', pipeline_status: 'submitted' });

      // AUTHORITATIVE fact: the submittal is submitted_to_ats with confirmed_at set.
      expect(await submittalState(sub)).toBe('submitted_to_ats|true');
      // MIRROR: pipeline reached submitted, with a history row from qualifying.
      expect(await pipelineStatus(pipe)).toBe('submitted');
      expect(await count('pipeline."PipelineStatusHistory"', 'pipeline_id=$1 AND status_from=\'qualifying\' AND status_to=\'submitted\'', [pipe])).toBe('1');
      // Durable side-effects, each exactly once.
      expect(await count('submittal."TalentSubmittalEvent"', 'submittal_id=$1', [sub])).toBe('1');
      expect(await count('submittal."OutboxEvent"', 'tenant_id=$1', [t])).toBe('1');
      expect(await count('activity."Activity"', 'subject_id=$1', [pipe])).toBe('1');
      expect(await count('metering."UsageEvent"', "tenant_id=$1 AND event_type='submittal.state_transition'", [t])).toBe('1');
      expect(await count('metering."UsageEvent"', "tenant_id=$1 AND event_type='pipeline.state_transition'", [t])).toBe('1');
      expect(await count('submittal_policy."SubmittalConsumption"', 'requisition_id=$1', [req])).toBe('1');
      expect(await count('submittal_policy."SubmittalPolicyEvent"', 'requisition_id=$1', [req])).toBe('1');
    });

    // ---- P2: concurrent limit=1 -------------------------------------------------
    it('P2 concurrent limit=1: exactly one commit, one consumption, one typed refusal', async () => {
      const t = randomUUID(), req = randomUUID();
      const tA = randomUUID(), tB = randomUUID();
      const pA = randomUUID(), pB = randomUUID(), sA = randomUUID(), sB = randomUUID();
      await seedRequisition(t, req, 'open'); // L1-C — the gate admits open; the limit=1 race is unchanged.
      await seedPolicy(t, req, 1);
      await seedPipeline(t, pA, tA, req);
      await seedPipeline(t, pB, tB, req);
      await seedSubmittal(t, sA, tA, req, pA);
      await seedSubmittal(t, sB, tB, req, pB);

      const results = await Promise.allSettled([
        svc.submitToClient({ tenant_id: t, submittal_id: sA, event_id: randomUUID(), actor_id: randomUUID(), requestId: 'p2a' }),
        svc.submitToClient({ tenant_id: t, submittal_id: sB, event_id: randomUUID(), actor_id: randomUUID(), requestId: 'p2b' }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason?.code).toBe('SUBMITTAL_LIMIT_REACHED');

      // Exactly one durable commit across the board.
      expect(await count('submittal_policy."SubmittalConsumption"', 'requisition_id=$1', [req])).toBe('1');
      expect(await count('submittal."TalentSubmittalRecord"', "job_id=$1 AND state='submitted_to_ats'", [req])).toBe('1');
      expect(await count('pipeline."Pipeline"', "requisition_id=$1 AND status='submitted'", [req])).toBe('1');
    });

    // ---- P3: forced failure after authoritative write → zero durable rows -------
    it('P3 forced failure after submitted_to_ats, before mirror completes → ZERO durable writes across all schemas', async () => {
      const t = randomUUID(), talent = randomUUID(), req = randomUUID();
      const pipe = randomUUID(), sub = randomUUID();
      await seedRequisition(t, req, 'open'); // L1-C — the gate admits open; the forced-failure atomicity proof is unchanged.
      await seedPipeline(t, pipe, talent, req);
      await seedSubmittal(t, sub, talent, req, pipe);

      failFlag.fail = true;
      await expect(
        svc.submitToClient({ tenant_id: t, submittal_id: sub, event_id: randomUUID(), actor_id: randomUUID(), requestId: 'p3' }),
      ).rejects.toThrow(/INJECTED/);

      // EVERY participating schema shows zero effect — the whole tx rolled back.
      expect(await submittalState(sub)).toBe('ready_for_review|false'); // authoritative write reverted
      expect(await pipelineStatus(pipe)).toBe('qualifying');            // mirror reverted
      expect(await count('submittal."TalentSubmittalEvent"', 'submittal_id=$1', [sub])).toBe('0');
      expect(await count('submittal."OutboxEvent"', 'tenant_id=$1', [t])).toBe('0');
      expect(await count('pipeline."PipelineStatusHistory"', 'pipeline_id=$1', [pipe])).toBe('0');
      expect(await count('activity."Activity"', 'subject_id=$1', [pipe])).toBe('0');
      expect(await count('metering."UsageEvent"', 'tenant_id=$1', [t])).toBe('0');
      expect(await count('submittal_policy."SubmittalConsumption"', 'requisition_id=$1', [req])).toBe('0');
      expect(await count('submittal_policy."SubmittalPolicyEvent"', 'requisition_id=$1', [req])).toBe('0');
    });

    // ---- P4: invalid link (null + identity mismatch) ----------------------------
    it('P4a null pipeline_id → SUBMITTAL_PIPELINE_LINK_INVALID, no writes', async () => {
      const t = randomUUID(), talent = randomUUID(), req = randomUUID(), sub = randomUUID();
      await seedRequisition(t, req, 'open'); // L1-C — the null-link refusal fires at step 3, BEFORE the gate; seeded for consistency.
      await seedSubmittal(t, sub, talent, req, null);
      await expect(
        svc.submitToClient({ tenant_id: t, submittal_id: sub, event_id: randomUUID(), actor_id: randomUUID(), requestId: 'p4a' }),
      ).rejects.toMatchObject({ code: 'SUBMITTAL_PIPELINE_LINK_INVALID' });
      expect(await submittalState(sub)).toBe('ready_for_review|false');
      expect(await count('submittal_policy."SubmittalConsumption"', 'requisition_id=$1', [req])).toBe('0');
    });

    it('P4b requisition-identity mismatch → SUBMITTAL_PIPELINE_LINK_INVALID, no writes', async () => {
      const t = randomUUID(), talent = randomUUID();
      const reqSub = randomUUID(), reqPipe = randomUUID(); // pipeline points at a DIFFERENT requisition
      const pipe = randomUUID(), sub = randomUUID();
      await seedRequisition(t, reqSub, 'open'); // L1-C — the identity-mismatch refusal fires at step 3, BEFORE the gate; seeded for consistency.
      await seedPipeline(t, pipe, talent, reqPipe);
      await seedSubmittal(t, sub, talent, reqSub, pipe);
      await expect(
        svc.submitToClient({ tenant_id: t, submittal_id: sub, event_id: randomUUID(), actor_id: randomUUID(), requestId: 'p4b' }),
      ).rejects.toMatchObject({ code: 'SUBMITTAL_PIPELINE_LINK_INVALID' });
      expect(await submittalState(sub)).toBe('ready_for_review|false');
      expect(await pipelineStatus(pipe)).toBe('qualifying');
    });

    // ---- P6: idempotent repeat consumes once -----------------------------------
    it('P6 idempotent repeat: second submit refused, slot consumed exactly once', async () => {
      const t = randomUUID(), talent = randomUUID(), req = randomUUID();
      const pipe = randomUUID(), sub = randomUUID();
      await seedRequisition(t, req, 'open'); // L1-C — the gate admits open; the idempotent-repeat refusal (step 2) is unchanged.
      await seedPipeline(t, pipe, talent, req);
      await seedSubmittal(t, sub, talent, req, pipe);

      await svc.submitToClient({ tenant_id: t, submittal_id: sub, event_id: randomUUID(), actor_id: randomUUID(), requestId: 'p6-1' });
      // Re-submit the now-submitted_to_ats submittal — the state machine refuses it.
      await expect(
        svc.submitToClient({ tenant_id: t, submittal_id: sub, event_id: randomUUID(), actor_id: randomUUID(), requestId: 'p6-2' }),
      ).rejects.toMatchObject({ code: 'SUBMITTAL_STATE_INVALID' });
      // Consumed exactly once — no double consumption.
      expect(await count('submittal_policy."SubmittalConsumption"', 'requisition_id=$1', [req])).toBe('1');
    });

    // ---- L1-C: the D6 SUBMIT gate — RecruitingStatus must be `open` -----------
    // Proofs 1-5: a client submittal against any NON-open requisition is refused
    // with REQUISITION_NOT_OPEN (409, details.status = the current status). The
    // pipeline link + submittal are valid, so the refusal is the status gate (3b),
    // not the link (3) or eligibility (4) gate — and NOTHING is mutated.
    for (const status of ['draft', 'on_hold', 'closed', 'canceled', 'submittals_closed'] as const) {
      it(`L1-C Rule 1: submit vs \`${status}\` requisition → REQUISITION_NOT_OPEN 409 (details.status=${status}), no writes`, async () => {
        const t = randomUUID(), talent = randomUUID(), req = randomUUID();
        const pipe = randomUUID(), sub = randomUUID();
        await seedRequisition(t, req, status);
        await seedPipeline(t, pipe, talent, req);
        await seedSubmittal(t, sub, talent, req, pipe);

        await expect(
          svc.submitToClient({ tenant_id: t, submittal_id: sub, event_id: randomUUID(), actor_id: randomUUID(), requestId: `l1c-${status}` }),
        ).rejects.toMatchObject({ code: 'REQUISITION_NOT_OPEN', statusCode: 409, context: { details: { status } } });

        // No mutation anywhere: submittal + pipeline untouched, nothing consumed.
        expect(await submittalState(sub)).toBe('ready_for_review|false');
        expect(await pipelineStatus(pipe)).toBe('qualifying');
        expect(await count('submittal_policy."SubmittalConsumption"', 'requisition_id=$1', [req])).toBe('0');
      });
    }

    // Proof 7 (Rule 3, NON-VACUOUS): the submit gate only READS RecruitingStatus,
    // it never WRITES it. A refused submit leaves Requisition.status exactly as it
    // was — asserted BEFORE and AFTER against the concrete `submittals_closed`.
    it('L1-C Rule 3 (non-vacuous): a refused submit does NOT mutate Requisition.status (BEFORE=submittals_closed, AFTER=submittals_closed)', async () => {
      const t = randomUUID(), talent = randomUUID(), req = randomUUID();
      const pipe = randomUUID(), sub = randomUUID();
      await seedRequisition(t, req, 'submittals_closed');
      await seedPipeline(t, pipe, talent, req);
      await seedSubmittal(t, sub, talent, req, pipe);

      // BEFORE — the requisition is submittals_closed.
      expect(await requisitionStatus(req)).toBe('submittals_closed');

      await expect(
        svc.submitToClient({ tenant_id: t, submittal_id: sub, event_id: randomUUID(), actor_id: randomUUID(), requestId: 'l1c-rule3' }),
      ).rejects.toMatchObject({ code: 'REQUISITION_NOT_OPEN' });

      // AFTER — unchanged. The gate is one-way (read-only); it wrote nothing.
      expect(await requisitionStatus(req)).toBe('submittals_closed');
    });
  },
);
