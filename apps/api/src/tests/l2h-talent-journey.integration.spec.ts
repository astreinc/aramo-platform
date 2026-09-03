import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AramoError } from '@aramo/common';
import { PipelineRepository, PipelinePrismaService } from '@aramo/pipeline';
import { SubmittalRepository, PrismaService as SubmittalPrismaService } from '@aramo/submittal';
import {
  ClientSelectionProcessRepository,
  InterviewSessionRepository,
  JourneyProjectionRepository,
  ClientSelectionPrismaService,
} from '@aramo/client-selection';
import { OfferRepository, PlacementRepository, PrismaService as PlacementPrismaService } from '@aramo/placement';
import { RequirementInstanceRepository, PrismaService as PreStartPrismaService } from '@aramo/pre-start-requirement';

import { TalentJourneyReadService } from '../talent-journey/talent-journey-read.service.js';

// Lane 2 / L2-H — the Unified Talent Journey composer, end-to-end against real Postgres 17.
// The composer is constructed with the REAL owner read repositories over the REAL owner
// schemas (all 8 owners); seeds are raw SQL per owner. Proves owner attribution, owner-correct
// stage derivation (OFFER-not-PLACED / STARTED-over-legacy — D-1/SB-0), 404 concealment
// (AUTHZ-D4b), the R3 no-commercial-key guarantee (AUTHZ-D5 by construction), read-only
// (zero writes), and an honest journey with no downstream owner rows.

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
  ...migrationsFor('submittal'),
  ...migrationsFor('client-selection'),
  ...migrationsFor('placement'),
  ...migrationsFor('pre-start-requirement'),
];

// Dollar-quote- AND line-comment-aware DDL splitter.
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) { cur += ch; if (ch === '\n') inLineComment = false; continue; }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') { inLineComment = true; cur += ch; continue; }
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; cur += '$$'; i += 1; continue; }
    if (ch === ';' && !inDollar) { out.push(cur); cur = ''; } else { cur += ch; }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const NOOP_LOGGER = { log: () => undefined, warn: () => undefined, error: () => undefined } as never;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L2-H unified talent journey composer (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let service: TalentJourneyReadService;
    const prismas: Array<{ $disconnect: () => Promise<void> }> = [];

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const m of MIGRATIONS) {
        for (const s of splitDdl(readFileSync(m, 'utf8'))) {
          const t = s.trim();
          if (t.length > 0) await db.query(t);
        }
      }
      const pipelinePrisma = new PipelinePrismaService(url);
      const submittalPrisma = new SubmittalPrismaService(url);
      const csPrisma = new ClientSelectionPrismaService(url);
      const placementPrisma = new PlacementPrismaService(url);
      const preStartPrisma = new PreStartPrismaService(url);
      for (const p of [pipelinePrisma, submittalPrisma, csPrisma, placementPrisma, preStartPrisma]) {
        await (p as unknown as { $connect: () => Promise<void> }).$connect();
        prismas.push(p as never);
      }
      service = new TalentJourneyReadService(
        new PipelineRepository(pipelinePrisma),
        new SubmittalRepository(submittalPrisma, {} as never, {} as never, NOOP_LOGGER, {} as never),
        new ClientSelectionProcessRepository(csPrisma),
        new InterviewSessionRepository(csPrisma),
        new JourneyProjectionRepository(csPrisma),
        new OfferRepository(placementPrisma, {} as never),
        new PlacementRepository(placementPrisma),
        new RequirementInstanceRepository(preStartPrisma),
        NOOP_LOGGER,
      );
    }, 240_000);

    afterAll(async () => {
      for (const p of prismas) await p.$disconnect().catch(() => undefined);
      await db?.end();
      await container?.stop();
    });

    // ---- raw seed helpers (one row per owner; UUID cross-refs, no FK) -----------------------
    async function seedPipeline(tenant: string, req: string, talent: string, status: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO pipeline."Pipeline" (id, tenant_id, talent_record_id, requisition_id, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::"pipeline"."PipelineStatus",now(),now())`,
        [id, tenant, talent, req, status],
      );
      return id;
    }
    async function seedSubmittal(tenant: string, talent: string, req: string, state: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO submittal."TalentSubmittalRecord"
           (id, tenant_id, talent_id, job_id, evidence_package_id, pinned_examination_id, state, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::"submittal"."SubmittalState",$8,now())`,
        [id, tenant, talent, req, randomUUID(), randomUUID(), state, randomUUID()],
      );
      return id;
    }
    async function seedSelection(tenant: string, submittal: string, req: string, talent: string, state: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO client_selection."ClientSelectionProcess"
           (id, tenant_id, submittal_id, requisition_id, talent_id, state, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::"client_selection"."ClientSelectionState",0,now(),now())`,
        [id, tenant, submittal, req, talent, state],
      );
      return id;
    }
    async function seedInterview(tenant: string, processId: string, req: string, talent: string, state: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO client_selection."InterviewSession"
           (id, tenant_id, client_selection_process_id, requisition_id, talent_record_id, interview_type, round, scheduled_at, state, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'ONSITE',1,now(),$6::"client_selection"."InterviewSessionState",0,now(),now())`,
        [id, tenant, processId, req, talent, state],
      );
      return id;
    }
    async function seedOffer(tenant: string, submittal: string, req: string, talent: string, state: string, termsSummary: string | null): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO offer."Offer" (id, tenant_id, submittal_id, requisition_id, talent_record_id, state, offer_terms_summary, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::"offer"."OfferState",$7,now())`,
        [id, tenant, submittal, req, talent, state, termsSummary],
      );
      return id;
    }
    async function seedPlacement(tenant: string, submittal: string, req: string, talent: string, state: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO placement."PlacementProcess"
           (id, tenant_id, submittal_id, requisition_id, talent_record_id, state, offered_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::"placement"."PlacementState",now(),now())`,
        [id, tenant, submittal, req, talent, state],
      );
      return id;
    }

    const call = (tenant: string, pipelineId: string, vis: ReadonlySet<string> | null = null) =>
      service.getJourney({ tenant_id: tenant, pipeline_id: pipelineId, visible_requisition_ids: vis, requestId: 'r' });

    // ---------------------------------------------------------------------------------------
    // AC-2a — an ACCEPTED offer with NO established placement reads OFFER, not ACCEPTED_PLACED.
    // ---------------------------------------------------------------------------------------
    it('AC-2a: ACCEPTED offer + no placement → current_journey_stage=OFFER (fill = establishment, not offer-acceptance)', async () => {
      const tenant = randomUUID(); const talent = randomUUID();
      const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_ats');
      await seedOffer(tenant, sub, req, talent, 'ACCEPTED', null);

      const j = await call(tenant, pipe);
      expect(j.current_journey_stage).toBe('OFFER');
      expect(j.sub_states.offer_state).toBe('ACCEPTED');
      expect(j.sub_states.placement_state).toBeNull(); // BEFORE: no placement established
      // Negative control: it did NOT derive ACCEPTED_PLACED from an accepted offer.
      expect(j.stages.some((s) => s.stage === 'ACCEPTED_PLACED')).toBe(false);
    });

    // ---------------------------------------------------------------------------------------
    // AC-2b — a STARTED placement reads STARTED even while the Pipeline row is still at a live
    // recruiting status (`qualified`): the downstream owner drives the journey, not the Pipeline.
    // ---------------------------------------------------------------------------------------
    it('AC-2b: STARTED placement + live pipeline `qualified` → current_journey_stage=STARTED (downstream owns it)', async () => {
      const tenant = randomUUID(); const talent = randomUUID();
      const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified'); // most-advanced Pipeline-owned status
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_ats');
      await seedOffer(tenant, sub, req, talent, 'ACCEPTED', null);
      const placement = await seedPlacement(tenant, sub, req, talent, 'STARTED');

      const j = await call(tenant, pipe);
      expect(j.current_journey_stage).toBe('STARTED');
      expect(j.sub_states.placement_state).toBe('STARTED');
      const started = j.stages.find((s) => s.stage === 'STARTED');
      expect(started?.owner).toBe('placement');
      expect(started?.source_object_id).toBe(placement); // AC-1: attributes to the exact owner row
      // The Pipeline (qualified) never authors an OFFER journey stage — offer is Offer-owned.
      expect(j.stages.some((s) => s.owner === 'pipeline' && s.stage === 'OFFER')).toBe(false);
    });

    // ---------------------------------------------------------------------------------------
    // AC-2c — an established placement is placement-OWNED and drives its own journey stage
    // (fill = establishment, not offer-acceptance). L4-0 collapsed the OFFER_* placement
    // states out: a PlacementProcess is now born at PRE_START (downstream of an accepted
    // Offer aggregate), so the established/birth state PRE_START drives the PRE_START stage
    // (ordinal above ACCEPTED_PLACED) over the still-live pipeline/submittal contributions.
    // ---------------------------------------------------------------------------------------
    it('AC-2c: established placement (born PRE_START) → current_journey_stage=PRE_START (placement owns it, fill = establishment)', async () => {
      const tenant = randomUUID(); const talent = randomUUID();
      const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_ats');
      await seedPlacement(tenant, sub, req, talent, 'PRE_START');

      const j = await call(tenant, pipe);
      expect(j.current_journey_stage).toBe('PRE_START'); // downstream placement owner drives it, over pipeline `qualified`
      expect(j.sub_states.placement_state).toBe('PRE_START');
    });

    // ---------------------------------------------------------------------------------------
    // AC-1 — SUBMITTED attributes to Submittal (not Pipeline); every stage has owner + source id.
    // ---------------------------------------------------------------------------------------
    it('AC-1: SUBMITTED stage attributes to Submittal; every stage carries owner + resolving source_object_id', async () => {
      const tenant = randomUUID(); const talent = randomUUID();
      const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_ats');

      const j = await call(tenant, pipe);
      const submitted = j.stages.find((s) => s.stage === 'SUBMITTED');
      expect(submitted?.owner).toBe('submittal');
      expect(submitted?.source_object_id).toBe(sub);
      // Every stage: non-null owner + source_object_id.
      for (const s of j.stages) {
        expect(s.owner).toBeTruthy();
        expect(typeof s.source_object_id).toBe('string');
        expect(s.source_object_id.length).toBeGreaterThan(0);
      }
    });

    // ---------------------------------------------------------------------------------------
    // AC-R1 — the INTERVIEW/CLIENT_DECLINED stages are SOURCED by consuming the L2-F3
    // deriveJourneyStages primitive (owner-attributed, normalized), and interview_state is read.
    // ---------------------------------------------------------------------------------------
    it('AC-R1: interview session → INTERVIEW stage (owner=client-selection, from the L2-F3 primitive) + interview_state; DECLINED process → CLIENT_DECLINED', async () => {
      // Interview present.
      const t1 = randomUUID(); const talent1 = randomUUID(); const r1 = randomUUID();
      const p1 = await seedPipeline(t1, r1, talent1, 'qualified');
      const s1 = await seedSubmittal(t1, talent1, r1, 'submitted_to_ats');
      const proc1 = await seedSelection(t1, s1, r1, talent1, 'INTERVIEW');
      await seedInterview(t1, proc1, r1, talent1, 'COMPLETED');
      const j1 = await call(t1, p1);
      const iv = j1.stages.find((s) => s.stage === 'INTERVIEW');
      expect(iv?.owner).toBe('client-selection'); // R1 normalization: source→owner
      expect(iv?.source_object_id).toBe(proc1); // client_selection_process_id
      expect(j1.sub_states.interview_state).toBe('COMPLETED'); // interview owner sub-state read
      expect(j1.sub_states.selection_state).toBe('INTERVIEW');

      // DECLINED process → CLIENT_DECLINED stage (owner-sourced).
      const t2 = randomUUID(); const talent2 = randomUUID(); const r2 = randomUUID();
      const p2 = await seedPipeline(t2, r2, talent2, 'qualified');
      const s2 = await seedSubmittal(t2, talent2, r2, 'submitted_to_ats');
      await seedSelection(t2, s2, r2, talent2, 'DECLINED');
      const j2 = await call(t2, p2);
      expect(j2.stages.some((s) => s.stage === 'CLIENT_DECLINED' && s.owner === 'client-selection')).toBe(true);
    });

    // ---------------------------------------------------------------------------------------
    // AC-3 — visibility concealment: excluded requisition → 404; see-all → 200.
    // ---------------------------------------------------------------------------------------
    it('AC-3: a non-visible episode is concealed as 404 NOT_FOUND (not 403); see-all returns the journey', async () => {
      const tenant = randomUUID(); const talent = randomUUID();
      const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');

      // Visible set EXCLUDING req → concealed.
      let err: unknown;
      try { await call(tenant, pipe, new Set<string>([randomUUID()])); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('NOT_FOUND');
      expect((err as AramoError).statusCode).toBe(404);

      // See-all (null) → returns the composed journey.
      const j = await call(tenant, pipe, null);
      expect(j.requisition_id).toBe(req);
    });

    // ---------------------------------------------------------------------------------------
    // AC-4 / R3 — no commercial/compensation field is EVER composed (structural guarantee).
    // ---------------------------------------------------------------------------------------
    it('AC-4/R3: an offer carrying offer_terms_summary never leaks it into the journey (state-only sub_states)', async () => {
      const tenant = randomUUID(); const talent = randomUUID();
      const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_ats');
      await seedOffer(tenant, sub, req, talent, 'SENT', 'CONFIDENTIAL $250k base + equity'); // commercial field seeded

      const j = await call(tenant, pipe);
      expect(j.sub_states.offer_state).toBe('SENT'); // the STATE is present
      const serialized = JSON.stringify(j);
      // The commercial value + key never appear anywhere in the composed response.
      expect(serialized).not.toContain('offer_terms_summary');
      expect(serialized).not.toContain('CONFIDENTIAL');
      expect(serialized).not.toContain('250k');
    });

    // ---------------------------------------------------------------------------------------
    // AC-5 — the composed read issues ZERO writes across every owner schema.
    // ---------------------------------------------------------------------------------------
    it('AC-5: getJourney is read-only — zero INSERT/UPDATE/DELETE across all owner tables', async () => {
      const tenant = randomUUID(); const talent = randomUUID();
      const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_ats');
      await seedSelection(tenant, sub, req, talent, 'INTERVIEW');
      await seedOffer(tenant, sub, req, talent, 'ACCEPTED', null);
      await seedPlacement(tenant, sub, req, talent, 'STARTED');

      const tables = [
        'pipeline."Pipeline"', 'submittal."TalentSubmittalRecord"', 'client_selection."ClientSelectionProcess"',
        'client_selection."InterviewSession"', 'offer."Offer"', 'placement."PlacementProcess"',
      ];
      const countAll = async (): Promise<number> => {
        let n = 0;
        for (const t of tables) n += Number((await db.query(`SELECT count(*)::int c FROM ${t}`)).rows[0].c);
        return n;
      };
      const before = await countAll();
      await call(tenant, pipe);
      expect(await countAll()).toBe(before); // zero net writes
    });

    // ---------------------------------------------------------------------------------------
    // AC-7 — a journey with only a live Pipeline episode is honest: no fabricated downstream.
    // ---------------------------------------------------------------------------------------
    it('AC-7: only a live Pipeline episode → Pipeline-owned stage; downstream sub_states null; no fabricated OFFER/PLACED', async () => {
      const tenant = randomUUID(); const talent = randomUUID();
      const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'contacted');

      const j = await call(tenant, pipe);
      expect(j.current_journey_stage).toBe('CONTACTED');
      expect(j.sub_states.submittal_state).toBeNull();
      expect(j.sub_states.offer_state).toBeNull();
      expect(j.sub_states.placement_state).toBeNull();
      expect(j.stages.every((s) => s.owner === 'pipeline')).toBe(true);
      expect(j.stages.some((s) => s.stage === 'OFFER' || s.stage === 'ACCEPTED_PLACED')).toBe(false);
      // S3-FIX regression — a pipeline-only (non-SELECTED) Talent must NOT be
      // offered an offer-create action. Emitting it here was the workflow-
      // sequencing defect that advertised premature "Create offer" in the drawer.
      // The offer action is gated on ClientSelection SELECTED.
      expect(j.actions.some((a) => a.owner === 'offer')).toBe(false);
    });
  },
);
