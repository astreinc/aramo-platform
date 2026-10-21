import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { PipelinePrismaService, PipelineRepository } from '@aramo/pipeline';

import { notRequiredQualifiedGuard } from './helpers/rtr-readiness-harness.js';
import { acceptingEvidenceVerifier } from './helpers/evidence-verifier.js';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 LOCKED §5 (S2, A1 AM-1 / AM-2) — the
// requisition-status gate on Pipeline activity, on REAL Postgres 17, through the real
// PipelineRepository (the RTR guard is the real composition-root guard over NOT_REQUIRED,
// so `qualified` runs its real lock + linearization; RTR itself is S1's spec).
//   §5.2  forward progression / backward correction / final disposition / system downstream
//   §5.3  in-transaction FOR SHARE read; refusals roll back the whole transaction
//   §5.5  a stale ADD decision cannot create an episode after the requisition changed
//   §5.8  Lead (D-2 provisional): Add + Contacted only

const ROOT = resolve(__dirname, '../../../..');
const migrationsFor = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};
const MIGRATIONS = [
  ...migrationsFor('requisition'),
  ...migrationsFor('activity'),
  ...migrationsFor('metering'),
  ...migrationsFor('pipeline'),
  ...migrationsFor('policy-store'),
];

const ACTOR = '01900000-0000-7000-8000-00000000a002';
const EVIDENCE = (): { kind: string; id: string } => ({ kind: 'communication_interaction', id: randomUUID() });
// v1.2 §7.2 (S4) — talent_responded rests on a recruiter response confirmation only.
const RESPONSE_EVIDENCE = (): { kind: string; id: string } => ({ kind: 'recruiter_response_confirmation', id: randomUUID() });

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'S2 — requisition lifecycle enforcement on Pipeline activity (v1.2 §5; real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let url: string;
    let db: Client;
    let prisma: PipelinePrismaService;
    let repo: PipelineRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const m of MIGRATIONS) await db.query(readFileSync(m, 'utf8'));
      prisma = new PipelinePrismaService(url);
      await prisma.$connect();
      repo = new PipelineRepository(prisma, notRequiredQualifiedGuard(), acceptingEvidenceVerifier());
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    }, 60_000);

    async function seedReq(status: string, tenant = randomUUID()): Promise<{ tenant: string; req: string }> {
      const req = randomUUID();
      await db.query(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, status, requisition_number)
         VALUES ($1,$2,'S2 fixture',$3,$4::requisition."RecruitingStatus",
                 (SELECT COALESCE(MAX(rn.requisition_number),999)+1 FROM requisition."Requisition" rn WHERE rn.tenant_id = $2))`,
        [req, tenant, randomUUID(), status],
      );
      return { tenant, req };
    }
    async function seedPipeline(tenant: string, req: string, status: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO pipeline."Pipeline" (id, tenant_id, talent_record_id, requisition_id, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::"pipeline"."PipelineStatus",now(),now())`,
        [id, tenant, randomUUID(), req, status],
      );
      return id;
    }
    async function setReqStatus(req: string, status: string): Promise<void> {
      await db.query(`UPDATE requisition."Requisition" SET status=$2::requisition."RecruitingStatus" WHERE id=$1`, [req, status]);
    }
    async function versionOf(p: string): Promise<number> {
      return (await db.query<{ version: number }>(`SELECT version FROM pipeline."Pipeline" WHERE id=$1`, [p])).rows[0]!.version;
    }
    async function statusOf(p: string): Promise<string> {
      return (await db.query<{ status: string }>(`SELECT status FROM pipeline."Pipeline" WHERE id=$1`, [p])).rows[0]!.status;
    }
    async function historyCount(p: string): Promise<number> {
      return (await db.query(`SELECT 1 FROM pipeline."PipelineStatusHistory" WHERE pipeline_id=$1`, [p])).rowCount ?? 0;
    }
    async function err(p: Promise<unknown>): Promise<{ code?: string; activity?: unknown; status?: unknown }> {
      try {
        await p;
        return { code: 'NO_THROW' };
      } catch (e) {
        const x = e as { code?: string; context?: { details?: { activity?: unknown; status?: unknown } } };
        return { code: x.code, activity: x.context?.details?.activity, status: x.context?.details?.status };
      }
    }
    const base = (tenant: string, id: string) => ({
      tenant_id: tenant,
      id,
      changed_by_id: ACTOR,
      requestId: `s2-${randomUUID()}`,
      visible_requisition_ids: null,
    });
    async function contact(tenant: string, p: string) {
      return repo.recordContactEvidence({ ...base(tenant, p), expected_version: await versionOf(p), evidence: EVIDENCE() });
    }
    async function respond(tenant: string, p: string) {
      return repo.recordResponseEvidence({ ...base(tenant, p), expected_version: await versionOf(p), evidence: RESPONSE_EVIDENCE() });
    }
    async function move(tenant: string, p: string, to: 'qualifying' | 'qualified' | 'no_contact' | 'talent_responded' | 'not_in_consideration') {
      return repo.transition({ ...base(tenant, p), to_status: to, expected_version: await versionOf(p) });
    }
    async function add(tenant: string, req: string, expected?: string) {
      return repo.create({
        tenant_id: tenant,
        input: { talent_record_id: randomUUID(), requisition_id: req },
        requestId: `s2-add-${randomUUID()}`,
        created_by_id: ACTOR,
        entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user', initiated_by_id: ACTOR },
        ...(expected === undefined ? {} : { expected_requisition_status: expected }),
      });
    }

    // ---- R-DIR acceptance objective (R1) ---------------------------------------------------
    it('On hold: Add → Contacted → Talent responded → Qualifying → Qualified all succeed (R1 acceptance)', async () => {
      const { tenant, req } = await seedReq('on_hold');
      const created = await add(tenant, req, 'on_hold');
      await contact(tenant, created.id);
      await respond(tenant, created.id);
      await move(tenant, created.id, 'qualifying');
      await move(tenant, created.id, 'qualified');
      expect(await statusOf(created.id)).toBe('qualified');
    });

    // ---- Closed / Canceled ------------------------------------------------------------------
    for (const terminal of ['closed', 'canceled'] as const) {
      describe(`${terminal} (A1 AM-1 §2.2 / AM-2)`, () => {
        it('Add is refused (REQUISITION_NOT_ADVANCEABLE, ADD) and nothing persists', async () => {
          const { tenant, req } = await seedReq(terminal);
          expect(await err(add(tenant, req))).toMatchObject({ code: 'REQUISITION_NOT_ADVANCEABLE', activity: 'ADD', status: terminal });
          const n = (await db.query(`SELECT 1 FROM pipeline."Pipeline" WHERE requisition_id=$1`, [req])).rowCount;
          expect(n).toBe(0);
        });

        it('every forward target is refused and the transaction rolls back (no history, no version bump)', async () => {
          const { tenant, req } = await seedReq('open');
          const p1 = await seedPipeline(tenant, req, 'no_contact');
          const p2 = await seedPipeline(tenant, req, 'contacted');
          const p3 = await seedPipeline(tenant, req, 'talent_responded');
          const p4 = await seedPipeline(tenant, req, 'qualifying');
          await setReqStatus(req, terminal);
          expect(await err(contact(tenant, p1))).toMatchObject({ code: 'REQUISITION_NOT_ADVANCEABLE', activity: 'CONTACT_EVIDENCE' });
          expect(await err(respond(tenant, p2))).toMatchObject({ code: 'REQUISITION_NOT_ADVANCEABLE', activity: 'RESPONSE' });
          expect(await err(move(tenant, p3, 'qualifying'))).toMatchObject({ activity: 'QUALIFY_DECISION' });
          expect(await err(move(tenant, p4, 'qualified'))).toMatchObject({ activity: 'QUALIFY_DECISION' });
          for (const [p, s] of [[p1, 'no_contact'], [p2, 'contacted'], [p3, 'talent_responded'], [p4, 'qualifying']] as const) {
            expect(await statusOf(p)).toBe(s);
            expect(await versionOf(p)).toBe(0);
            expect(await historyCount(p)).toBe(0);
          }
        });

        it('an ordinary backward correction is refused (L-3)', async () => {
          const { tenant, req } = await seedReq('open');
          const p = await seedPipeline(tenant, req, 'qualified');
          await setReqStatus(req, terminal);
          expect(await err(move(tenant, p, 'qualifying'))).toMatchObject({
            code: 'REQUISITION_NOT_ADVANCEABLE',
            activity: 'BACKWARD_CORRECTION',
          });
          expect(await statusOf(p)).toBe('qualified');
        });

        it('a reasonless /transition to not_in_consideration is refused; a governed DISPOSITION with its reason is allowed (L-3)', async () => {
          const { tenant, req } = await seedReq('open');
          const p = await seedPipeline(tenant, req, 'contacted');
          await setReqStatus(req, terminal);
          // Remediation Directive v1.0 R1 (DEF-5): a reasonless move is refused on EVERY status, first.
          expect(await err(move(tenant, p, 'not_in_consideration'))).toMatchObject({ code: 'PIPELINE_DISPOSITION_REASON_INVALID' });
          await repo.applyAction({
            ...base(tenant, p),
            action: 'DISPOSITION',
            expected_version: await versionOf(p),
            authority_class: 'ENGAGEMENT',
            reason: 'requisition_closed',
          });
          expect(await statusOf(p)).toBe('not_in_consideration');
        });

        it('the system COMPLETE command (placement domain authority) is NOT gated', async () => {
          const { tenant, req } = await seedReq('open');
          const p = await seedPipeline(tenant, req, 'qualified');
          await setReqStatus(req, terminal); // e.g. the requisition closed once filled
          await repo.complete({
            ...base(tenant, p),
            expected_version: await versionOf(p),
            scopes: ['pipeline:complete'],
            source_provenance: randomUUID(), // the owning placement's UUID lineage
            reason: 'placement_started',
          });
          expect(await statusOf(p)).toBe('completed');
        });
      });
    }

    // ---- Lead (D-2 provisional) -------------------------------------------------------------
    // ---- Pipeline & RTR Recon Remediation Directive v1.0 R1 (DEF-5) ---------------------------
    for (const status of ['open', 'on_hold', 'lead'] as const) {
      it(`R1 (DEF-5): on a ${status} requisition a reasonless move to not_in_consideration is refused; DISPOSITION with a reason closes it`, async () => {
        const { tenant, req } = await seedReq(status);
        const p = await seedPipeline(tenant, req, 'contacted');
        const before = await versionOf(p);
        const r = await err(move(tenant, p, 'not_in_consideration'));
        expect(r.code).toBe('PIPELINE_DISPOSITION_REASON_INVALID');
        expect(await statusOf(p)).toBe('contacted');
        expect(await versionOf(p)).toBe(before);
        await repo.applyAction({
          ...base(tenant, p),
          action: 'DISPOSITION',
          expected_version: await versionOf(p),
          authority_class: 'TALENT',
          reason: 'talent_declined',
        });
        expect(await statusOf(p)).toBe('not_in_consideration');
        const d = await prisma.$queryRawUnsafe<Array<{ reason: string; authority_class: string }>>(
          `SELECT reason, authority_class FROM pipeline."PipelineDisposition" WHERE pipeline_id = $1::uuid`,
          p,
        );
        expect(d).toEqual([{ reason: 'talent_declined', authority_class: 'TALENT' }]);
      });
    }

    it('R1 (DEF-5): a recruiter DISPOSITION cannot use a system DOWNSTREAM_OUTCOME reason', async () => {
      const { tenant, req } = await seedReq('open');
      const p = await seedPipeline(tenant, req, 'contacted');
      const r = await err(
        repo.applyAction({
          ...base(tenant, p),
          action: 'DISPOSITION',
          expected_version: await versionOf(p),
          authority_class: 'DOWNSTREAM_OUTCOME' as never,
          reason: 'placement_fell_through',
        }),
      );
      expect(r.code).toBe('PIPELINE_DISPOSITION_REASON_INVALID');
      expect(await statusOf(p)).toBe('contacted');
    });

    it('Lead (D-2 provisional): Add and Contacted allowed; Talent responded / Qualifying refused', async () => {
      const { tenant, req } = await seedReq('lead');
      const created = await add(tenant, req, 'lead');
      await contact(tenant, created.id); // D-2 provisional (A1 §1)
      expect(await statusOf(created.id)).toBe('contacted');
      expect(await err(respond(tenant, created.id))).toMatchObject({ code: 'REQUISITION_NOT_ADVANCEABLE', activity: 'RESPONSE' });
      const p = await seedPipeline(tenant, req, 'talent_responded');
      expect(await err(move(tenant, p, 'qualifying'))).toMatchObject({ activity: 'QUALIFY_DECISION' });
    });

    // ---- fail-closed --------------------------------------------------------------------------
    it('a requisition that does not resolve in the tenant refuses the transition (§2.6)', async () => {
      const tenant = randomUUID();
      const p = await seedPipeline(tenant, randomUUID(), 'talent_responded'); // no requisition row
      expect(await err(move(tenant, p, 'qualifying'))).toMatchObject({ code: 'REQUISITION_NOT_ADVANCEABLE', activity: 'REQUISITION_UNRESOLVED' });
    });

    // ---- §5.5 stale decision ----------------------------------------------------------------
    it('a stale ADD decision (made on open, requisition since closed) cannot create an episode', async () => {
      const { tenant, req } = await seedReq('open');
      await setReqStatus(req, 'closed'); // the status changed after the policy decision
      expect(await err(add(tenant, req, 'open'))).toMatchObject({ code: 'TRANSACTION_CONFLICT_RETRYABLE' });
      const n = (await db.query(`SELECT 1 FROM pipeline."Pipeline" WHERE requisition_id=$1`, [req])).rowCount;
      expect(n).toBe(0);
    });

    // ---- §5.3 concurrency: status writer versus transition ----------------------------------
    it('a status writer holding the requisition FOR UPDATE blocks a transition; after CLOSE commits the transition is refused', async () => {
      const { tenant, req } = await seedReq('open');
      const p = await seedPipeline(tenant, req, 'talent_responded');
      const writer = new Client({ connectionString: url });
      await writer.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(`SELECT status FROM requisition."Requisition" WHERE id=$1 FOR UPDATE`, [req]);
        const t = err(move(tenant, p, 'qualifying'));
        for (let i = 0; i < 200; i++) {
          const r = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_locks WHERE NOT granted`);
          if (Number(r.rows[0]!.n) > 0) break;
          await new Promise((res) => setTimeout(res, 25));
        }
        await writer.query(`UPDATE requisition."Requisition" SET status='closed'::requisition."RecruitingStatus" WHERE id=$1`, [req]);
        await writer.query('COMMIT');
        expect(await t).toMatchObject({ code: 'REQUISITION_NOT_ADVANCEABLE', status: 'closed' });
        expect(await statusOf(p)).toBe('talent_responded');
        expect(await historyCount(p)).toBe(0);
      } finally {
        await writer.end();
      }
    });

    it('a transition holding the requisition FOR SHARE blocks a status writer until it commits', async () => {
      const { tenant, req } = await seedReq('open');
      const p = await seedPipeline(tenant, req, 'talent_responded');
      const pauser = new Client({ connectionString: url });
      const writer = new Client({ connectionString: url });
      await pauser.connect();
      await writer.connect();
      try {
        await pauser.query('BEGIN');
        await pauser.query('LOCK TABLE pipeline."PipelineStatusHistory" IN EXCLUSIVE MODE'); // pause after the gate
        const t = move(tenant, p, 'qualifying');
        for (let i = 0; i < 200; i++) {
          const r = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_locks WHERE NOT granted`);
          if (Number(r.rows[0]!.n) > 0) break;
          await new Promise((res) => setTimeout(res, 25));
        }
        await writer.query('BEGIN');
        await writer.query(`SET LOCAL lock_timeout = '1500ms'`);
        await expect(
          writer.query(`SELECT status FROM requisition."Requisition" WHERE id=$1 FOR UPDATE`, [req]),
        ).rejects.toMatchObject({ code: '55P03' });
        await writer.query('ROLLBACK');
        await pauser.query('COMMIT');
        await t;
        expect(await statusOf(p)).toBe('qualifying');
      } finally {
        await pauser.end();
        await writer.end();
      }
    });
  },
);
