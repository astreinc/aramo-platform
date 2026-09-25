import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import { PipelineRepository, PipelinePrismaService } from '@aramo/pipeline';
import { SubmittalRepository, PrismaService as SubmittalPrismaService } from '@aramo/submittal';
import { ClientSelectionProcessRepository, ClientSelectionPrismaService } from '@aramo/client-selection';
import { OfferRepository, PlacementRepository, PrismaService as PlacementPrismaService } from '@aramo/placement';
import { RequisitionSubmittalEligibilityReader, PrismaService as EligibilityPrismaService } from '@aramo/submittal-eligibility';
import { RequisitionAssignmentRepository, RequisitionPrismaService } from '@aramo/requisition';

import { RequisitionTalentBoardReadService } from '../requisition-talent-board/requisition-talent-board-read.service.js';

// Requisition Talent Board (TB-1) — the Board read-composer, end-to-end against real
// Postgres 17. The composer is constructed with the REAL owner read repositories over the
// REAL owner schemas; seeds are raw SQL per owner (UUID cross-refs, no FK except the
// intra-schema RequisitionAssignment→Requisition). Proves: deepest-owner column derivation,
// owner attribution (source_object_id), canonical-state-only projection, correct Closed
// derivation, tenant isolation, requisition scoping, 404 concealment (AUTHZ-D4b), the
// STATE-ENUMS-ONLY no-compensation guarantee, résumé linkage (working vs frozen), days-in-
// stage from history, the assigned recruiter, the Qualified band — and NO per-card fan-out
// (every batched reader is invoked exactly once regardless of card count — directive §19).

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
  ...migrationsFor('submittal-eligibility'),
];

// Dollar-quote- AND line-comment-aware DDL splitter (the comment-blind-splitter trap).
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
const FIXED_NOW = new Date('2026-01-15T00:00:00.000Z');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TB-1 requisition talent board composer (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let service: RequisitionTalentBoardReadService;
    let pipelineRepo: PipelineRepository;
    let submittalRepo: SubmittalRepository;
    let selectionRepo: ClientSelectionProcessRepository;
    let offerRepo: OfferRepository;
    let placementRepo: PlacementRepository;
    let readinessReader: RequisitionSubmittalEligibilityReader;
    let assignmentRepo: RequisitionAssignmentRepository;
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
      const eligibilityPrisma = new EligibilityPrismaService(url);
      const requisitionPrisma = new RequisitionPrismaService(url);
      for (const p of [pipelinePrisma, submittalPrisma, csPrisma, placementPrisma, eligibilityPrisma, requisitionPrisma]) {
        await (p as unknown as { $connect: () => Promise<void> }).$connect();
        prismas.push(p as never);
      }
      pipelineRepo = new PipelineRepository(pipelinePrisma);
      submittalRepo = new SubmittalRepository(submittalPrisma, {} as never, {} as never, NOOP_LOGGER, {} as never);
      selectionRepo = new ClientSelectionProcessRepository(csPrisma);
      offerRepo = new OfferRepository(placementPrisma, {} as never);
      placementRepo = new PlacementRepository(placementPrisma);
      readinessReader = new RequisitionSubmittalEligibilityReader(eligibilityPrisma as never);
      assignmentRepo = new RequisitionAssignmentRepository(requisitionPrisma as never);
      service = new RequisitionTalentBoardReadService(
        pipelineRepo,
        submittalRepo,
        selectionRepo,
        offerRepo,
        placementRepo,
        readinessReader,
        assignmentRepo,
        NOOP_LOGGER,
      );
    }, 240_000);

    afterAll(async () => {
      for (const p of prismas) await p.$disconnect().catch(() => undefined);
      await db?.end();
      await container?.stop();
    });

    // ---- raw seed helpers (one row per owner; UUID cross-refs) ------------------------------
    async function seedPipeline(tenant: string, req: string, talent: string, status: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO pipeline."Pipeline" (id, tenant_id, talent_record_id, requisition_id, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::"pipeline"."PipelineStatus",now(),now())`,
        [id, tenant, talent, req, status],
      );
      return id;
    }
    async function seedHistory(tenant: string, pipelineId: string, statusTo: string, changedAt: Date): Promise<void> {
      await db.query(
        `INSERT INTO pipeline."PipelineStatusHistory" (id, tenant_id, pipeline_id, status_from, status_to, changed_at)
         VALUES ($1,$2,$3,NULL,$4::"pipeline"."PipelineStatus",$5)`,
        [randomUUID(), tenant, pipelineId, statusTo, changedAt.toISOString()],
      );
    }
    async function seedResume(tenant: string, talent: string, req: string, editionId: string, selectedAt: Date): Promise<void> {
      await db.query(
        `INSERT INTO pipeline."TalentRequisitionResume" (id, tenant_id, talent_record_id, requisition_id, resume_edition_id, selected_at, selected_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), tenant, talent, req, editionId, selectedAt.toISOString(), randomUUID()],
      );
    }
    async function seedSubmittal(
      tenant: string, talent: string, req: string, state: string, pipelineId: string | null, resumeEditionId: string | null,
    ): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO submittal."TalentSubmittalRecord"
           (id, tenant_id, talent_id, job_id, evidence_package_id, pinned_examination_id, state, created_by, pipeline_id, resume_edition_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::"submittal"."SubmittalState",$8,$9,$10,now())`,
        [id, tenant, talent, req, randomUUID(), randomUUID(), state, randomUUID(), pipelineId, resumeEditionId],
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
    async function seedOffer(
      tenant: string, submittal: string, req: string, talent: string, state: string, termsSummary: string | null, declineReason: string | null,
    ): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO offer."Offer" (id, tenant_id, submittal_id, requisition_id, talent_record_id, state, offer_terms_summary, decline_reason, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::"offer"."OfferState",$7,$8,now())`,
        [id, tenant, submittal, req, talent, state, termsSummary, declineReason],
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
    async function seedRequisition(tenant: string, req: string): Promise<void> {
      await db.query(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, requisition_number, company_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [req, tenant, 'Board Test Requisition', Math.floor(Math.random() * 1_000_000), randomUUID()],
      );
    }
    async function seedAssignment(tenant: string, req: string, userId: string): Promise<void> {
      await db.query(
        `INSERT INTO requisition."RequisitionAssignment" (id, tenant_id, requisition_id, user_id, assigned_at)
         VALUES ($1,$2,$3,$4,now())`,
        [randomUUID(), tenant, req, userId],
      );
    }

    const call = (tenant: string, req: string, vis: ReadonlySet<string> | null = null) =>
      service.getBoard({ tenant_id: tenant, requisition_id: req, visible_requisition_ids: vis, now: FIXED_NOW, requestId: 'r' });

    const cardsIn = (board: Awaited<ReturnType<typeof call>>, key: string) =>
      board.columns.find((c) => c.key === key)?.cards ?? [];
    const anyCard = (board: Awaited<ReturnType<typeof call>>, talent: string) =>
      board.columns.flatMap((c) => c.cards).find((c) => c.talent_record_id === talent);

    // ---------------------------------------------------------------------------------------
    // TB1-1 — the deepest owner with a row owns the column; SUBMITTED attributes to the
    // Submittal even while the Pipeline is still `qualified`.
    // ---------------------------------------------------------------------------------------
    it('TB1-1: pipeline `qualified` + submitted_to_ats submittal → card in `submitted`, owner=submittal, attributed to the submittal row', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_ats', pipe, null);

      const board = await call(tenant, req);
      const submitted = cardsIn(board, 'submitted');
      expect(submitted).toHaveLength(1);
      expect(submitted[0]!.owner).toBe('submittal');
      expect(submitted[0]!.owner_state).toBe('submitted_to_ats');
      expect(submitted[0]!.source_object_id).toBe(sub);
      expect(submitted[0]!.pipeline_id).toBe(pipe);
      // The card is NOT double-counted in the pipeline `qualified` column.
      expect(cardsIn(board, 'qualified')).toHaveLength(0);
      expect(board.total_active).toBe(1);
    });

    // ---------------------------------------------------------------------------------------
    // TB1-2 — the DEEPEST owner drives the column: a STARTED placement beats a live pipeline/
    // submittal/selection/offer chain (downstream owns it — mirrors talent-journey).
    // ---------------------------------------------------------------------------------------
    it('TB1-2: full chain with STARTED placement → card in `started`, owner=placement', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_ats', pipe, null);
      await seedSelection(tenant, sub, req, talent, 'SELECTED');
      await seedOffer(tenant, sub, req, talent, 'ACCEPTED', null, null);
      const placement = await seedPlacement(tenant, sub, req, talent, 'STARTED');

      const board = await call(tenant, req);
      const started = cardsIn(board, 'started');
      expect(started).toHaveLength(1);
      expect(started[0]!.owner).toBe('placement');
      expect(started[0]!.owner_state).toBe('STARTED');
      expect(started[0]!.source_object_id).toBe(placement);
    });

    // ---------------------------------------------------------------------------------------
    // TB1-3 — per-owner column mapping across the middle of the board.
    // ---------------------------------------------------------------------------------------
    it('TB1-3: selection INTERVIEW→interview; SELECTED→selected; offer SENT→offer; offer ACCEPTED→accepted', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      const mk = async (state: string, kind: 'interview' | 'selected' | 'offer' | 'accepted'): Promise<void> => {
        const talent = randomUUID();
        const pipe = await seedPipeline(tenant, req, talent, 'qualified');
        const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_ats', pipe, null);
        if (kind === 'interview') await seedSelection(tenant, sub, req, talent, state);
        else if (kind === 'selected') await seedSelection(tenant, sub, req, talent, state);
        else await seedOffer(tenant, sub, req, talent, state, null, null);
      };
      await mk('INTERVIEW', 'interview');
      await mk('SELECTED', 'selected');
      await mk('SENT', 'offer');
      await mk('ACCEPTED', 'accepted');

      const board = await call(tenant, req);
      expect(cardsIn(board, 'interview').map((c) => c.owner_state)).toEqual(['INTERVIEW']);
      expect(cardsIn(board, 'selected').map((c) => c.owner_state)).toEqual(['SELECTED']);
      expect(cardsIn(board, 'offer').map((c) => c.owner_state)).toEqual(['SENT']);
      expect(cardsIn(board, 'accepted').map((c) => c.owner_state)).toEqual(['ACCEPTED']);
    });

    // ---------------------------------------------------------------------------------------
    // TB1-4 — Closed derivation: pipeline disposition + downstream negative terminals, grouped
    // by canonical reason; never in an active column.
    // ---------------------------------------------------------------------------------------
    it('TB1-4: not_in_consideration / offer DECLINED / placement FELL_THROUGH → Closed panel, canonical reasons', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      // not_in_consideration (pipeline disposition — the canonical closed spine).
      await seedPipeline(tenant, req, randomUUID(), 'not_in_consideration');
      // offer DECLINED (deepest owner is a closed-position offer).
      const t2 = randomUUID(); const p2 = await seedPipeline(tenant, req, t2, 'qualified');
      const s2 = await seedSubmittal(tenant, t2, req, 'submitted_to_ats', p2, null);
      await seedOffer(tenant, s2, req, t2, 'DECLINED', null, 'client_passed');
      // placement FELL_THROUGH (deepest owner is a negative placement terminal).
      const t3 = randomUUID(); const p3 = await seedPipeline(tenant, req, t3, 'completed');
      const s3 = await seedSubmittal(tenant, t3, req, 'submitted_to_ats', p3, null);
      await seedPlacement(tenant, s3, req, t3, 'FELL_THROUGH');

      const board = await call(tenant, req);
      expect(board.total_active).toBe(0);
      expect(board.closed.total).toBe(3);
      const reasons = Object.fromEntries(board.closed.by_reason.map((r) => [r.reason, r.count]));
      expect(reasons['not_in_consideration']).toBe(1);
      expect(reasons['offer_declined']).toBe(1);
      expect(reasons['placement_fell_through']).toBe(1);
      // A closed card never appears in any active column.
      for (const col of board.columns) expect(col.cards).toHaveLength(0);
    });

    // ---------------------------------------------------------------------------------------
    // TB1-5 — tenant isolation: an identical requisition_id under another tenant never leaks.
    // ---------------------------------------------------------------------------------------
    it('TB1-5: tenant isolation — same requisition_id under a different tenant is invisible', async () => {
      const req = randomUUID();
      const tenantA = randomUUID(); const tenantB = randomUUID();
      const pipeA = await seedPipeline(tenantA, req, randomUUID(), 'qualified');
      await seedPipeline(tenantB, req, randomUUID(), 'qualified'); // cross-tenant, same req id

      const board = await call(tenantA, req);
      expect(board.total_active).toBe(1);
      expect(cardsIn(board, 'qualified')[0]!.pipeline_id).toBe(pipeA);
    });

    // ---------------------------------------------------------------------------------------
    // TB1-6 — requisition scoping: a sibling requisition's talent never appears.
    // ---------------------------------------------------------------------------------------
    it('TB1-6: requisition scoping — a second requisition in the same tenant is excluded', async () => {
      const tenant = randomUUID(); const req1 = randomUUID(); const req2 = randomUUID();
      await seedPipeline(tenant, req1, randomUUID(), 'contacted');
      await seedPipeline(tenant, req2, randomUUID(), 'contacted');

      const board = await call(tenant, req1);
      expect(board.total_active).toBe(1);
      expect(cardsIn(board, 'contacted')).toHaveLength(1);
    });

    // ---------------------------------------------------------------------------------------
    // TB1-7 — visibility concealment (AUTHZ-D4b): a non-visible requisition → 404; see-all → 200.
    // ---------------------------------------------------------------------------------------
    it('TB1-7: a non-visible requisition is concealed as 404 (not 403); see-all returns the board', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      await seedPipeline(tenant, req, randomUUID(), 'qualified');

      let err: unknown;
      try { await call(tenant, req, new Set<string>([randomUUID()])); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('NOT_FOUND');
      expect((err as AramoError).statusCode).toBe(404);

      const board = await call(tenant, req, new Set<string>([req]));
      expect(board.requisition_id).toBe(req);
      expect(board.total_active).toBe(1);
    });

    // ---------------------------------------------------------------------------------------
    // TB1-8 — STATE ENUMS ONLY: an offer's commercial fields never leak into the board.
    // ---------------------------------------------------------------------------------------
    it('TB1-8: an offer carrying offer_terms_summary never leaks a compensation field (state-only)', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_ats', pipe, null);
      await seedOffer(tenant, sub, req, talent, 'SENT', 'CONFIDENTIAL $250k base + equity', null);

      const board = await call(tenant, req);
      expect(cardsIn(board, 'offer')[0]!.owner_state).toBe('SENT'); // the STATE is present
      const serialized = JSON.stringify(board);
      expect(serialized).not.toContain('offer_terms_summary');
      expect(serialized).not.toContain('CONFIDENTIAL');
      expect(serialized).not.toContain('250k');
    });

    // ---------------------------------------------------------------------------------------
    // TB1-9 — NO per-card fan-out (§19): every batched reader is invoked EXACTLY ONCE,
    // independent of card count. Seed 30 talent; spy on all 9 owner reads.
    // ---------------------------------------------------------------------------------------
    it('TB1-9: 30 cards → each batched reader called exactly once (no N+1 / per-card fan-out)', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      for (let i = 0; i < 30; i++) {
        const talent = randomUUID();
        const pipe = await seedPipeline(tenant, req, talent, 'qualified');
        await seedSubmittal(tenant, talent, req, 'submitted_to_ats', pipe, null);
      }
      const spies = [
        vi.spyOn(pipelineRepo, 'listByRequisitionsAndStatus'),
        vi.spyOn(pipelineRepo, 'listCurrentRequisitionResumes'),
        vi.spyOn(pipelineRepo, 'listLatestStatusEntryForPipelines'),
        vi.spyOn(submittalRepo, 'listByRequisitionForBoard'),
        vi.spyOn(selectionRepo, 'listBySubmittalIds'),
        vi.spyOn(offerRepo, 'list'),
        vi.spyOn(placementRepo, 'listForActor'),
        vi.spyOn(readinessReader, 'deriveByRequisitionIds'),
        vi.spyOn(assignmentRepo, 'listForRequisition'),
      ];
      try {
        const board = await call(tenant, req);
        expect(board.total_active).toBe(30);
        for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1); // constant queries, not O(cards)
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });

    // ---------------------------------------------------------------------------------------
    // TB1-10 — résumé linkage (§13): working selection pre-submit; frozen edition post-submit.
    // NEVER the talent's latest résumé.
    // ---------------------------------------------------------------------------------------
    it('TB1-10: pre-submit → working_selection (unlocked); submitted → submitted_frozen (locked)', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      // Pre-submit: a working résumé selection on a qualified pipeline (no submittal).
      const t1 = randomUUID(); await seedPipeline(tenant, req, t1, 'qualified');
      const working = randomUUID();
      await seedResume(tenant, t1, req, working, new Date('2026-01-10T00:00:00Z'));
      // Post-submit: a submittal with a frozen resume_edition_id.
      const t2 = randomUUID(); const p2 = await seedPipeline(tenant, req, t2, 'qualified');
      const frozen = randomUUID();
      await seedSubmittal(tenant, t2, req, 'submitted_to_ats', p2, frozen);

      const board = await call(tenant, req);
      const q = cardsIn(board, 'qualified').find((c) => c.talent_record_id === t1)!;
      expect(q.resume).toEqual({ resume_edition_id: working, source: 'working_selection', locked: false });
      const s = cardsIn(board, 'submitted').find((c) => c.talent_record_id === t2)!;
      expect(s.resume).toEqual({ resume_edition_id: frozen, source: 'submitted_frozen', locked: true });
    });

    // ---------------------------------------------------------------------------------------
    // TB1-11 — days-in-stage from the latest PipelineStatusHistory transition (§22 / G-A).
    // ---------------------------------------------------------------------------------------
    it('TB1-11: days_in_stage derived from the latest history changed_at (not updated_at)', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'contacted');
      await seedHistory(tenant, pipe, 'no_contact', new Date('2026-01-01T00:00:00Z'));
      await seedHistory(tenant, pipe, 'contacted', new Date('2026-01-12T00:00:00Z')); // 3 days before FIXED_NOW

      const board = await call(tenant, req);
      const card = cardsIn(board, 'contacted')[0]!;
      expect(card.days_in_stage).toBe(3);
      expect(card.stage_entered_at).toBe('2026-01-12T00:00:00.000Z');
    });

    // ---------------------------------------------------------------------------------------
    // TB1-12 — assigned recruiter (§14 / G-B): requisition-grain RequisitionAssignment.user_id.
    // ---------------------------------------------------------------------------------------
    it('TB1-12: assigned_recruiter_user_id resolves from the requisition-grain assignment', async () => {
      const tenant = randomUUID(); const req = randomUUID(); const recruiter = randomUUID();
      await seedRequisition(tenant, req);
      await seedAssignment(tenant, req, recruiter);
      await seedPipeline(tenant, req, randomUUID(), 'qualified');

      const board = await call(tenant, req);
      expect(cardsIn(board, 'qualified')[0]!.assigned_recruiter_user_id).toBe(recruiter);
    });

    // ---------------------------------------------------------------------------------------
    // TB1-13 — the Qualified band (§6): ready_to_submit vs needs_action with specific blockers.
    // ---------------------------------------------------------------------------------------
    it('TB1-13: Qualified band = ready_to_submit with a résumé (open req); needs_action + resume_not_selected without', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      const ready = randomUUID(); await seedPipeline(tenant, req, ready, 'qualified');
      await seedResume(tenant, ready, req, randomUUID(), new Date('2026-01-10T00:00:00Z'));
      const needs = randomUUID(); await seedPipeline(tenant, req, needs, 'qualified'); // no résumé

      const board = await call(tenant, req);
      const readyCard = cardsIn(board, 'qualified').find((c) => c.talent_record_id === ready)!;
      expect(readyCard.readiness?.band).toBe('ready_to_submit');
      expect(readyCard.readiness?.blockers).toEqual([]);
      expect(readyCard.readiness?.requisition_state).toBe('open'); // R-DEFAULT-OPEN (no policy row)
      const needsCard = cardsIn(board, 'qualified').find((c) => c.talent_record_id === needs)!;
      expect(needsCard.readiness?.band).toBe('needs_action');
      expect(needsCard.readiness?.blockers).toContain('resume_not_selected');
    });

    // ---------------------------------------------------------------------------------------
    // TB3-1 — the bounded pipeline recruiter-action ladder is owner-attributed + routed to the
    // EXISTING governed command (POST /v1/pipelines/:id/actions, pipeline:change-status).
    // ---------------------------------------------------------------------------------------
    it('TB3-1: a `qualifying` pipeline card projects a single Qualify action on the governed pipeline route', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualifying');

      const board = await call(tenant, req);
      const card = anyCard(board, talent)!;
      expect(card.next_actions).toHaveLength(1);
      expect(card.next_actions[0]).toMatchObject({
        key: 'pipeline.qualify',
        owner: 'pipeline',
        command_route: `POST /v1/pipelines/${pipe}/actions`,
        required_scope: 'pipeline:change-status',
      });
    });

    // ---------------------------------------------------------------------------------------
    // TB3-2 — the offer-create action is SELECTED-gated (the S3-FIX sequencing guard): a card in
    // INTERVIEW never advertises Create offer; a SELECTED card does, on POST /v1/offers.
    // ---------------------------------------------------------------------------------------
    it('TB3-2: Create offer appears only on a SELECTED card, never on INTERVIEW (SELECTED-gated handoff)', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      const tI = randomUUID(); const pI = await seedPipeline(tenant, req, tI, 'qualified');
      const sI = await seedSubmittal(tenant, tI, req, 'submitted_to_ats', pI, null);
      await seedSelection(tenant, sI, req, tI, 'INTERVIEW');
      const tS = randomUUID(); const pS = await seedPipeline(tenant, req, tS, 'qualified');
      const sS = await seedSubmittal(tenant, tS, req, 'submitted_to_ats', pS, null);
      await seedSelection(tenant, sS, req, tS, 'SELECTED');

      const board = await call(tenant, req);
      const interviewCard = anyCard(board, tI)!;
      expect(interviewCard.next_actions.some((a) => a.key === 'offer.create')).toBe(false);
      expect(interviewCard.next_actions.map((a) => a.key)).toEqual(['client_selection.mark_selected']);
      const selectedCard = anyCard(board, tS)!;
      expect(selectedCard.next_actions).toEqual([
        { key: 'offer.create', label: 'Create offer', owner: 'offer', command_route: 'POST /v1/offers', required_scope: 'offer:create' },
      ]);
    });

    // ---------------------------------------------------------------------------------------
    // TB3-3 — a Closed card (and a post-submit submittal with no forward owner command) projects
    // NO next action (the Board never advertises a command a terminal/handoff card cannot run).
    // ---------------------------------------------------------------------------------------
    it('TB3-3: a not_in_consideration card is Closed and carries no card (no action projected)', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      await seedPipeline(tenant, req, randomUUID(), 'not_in_consideration');
      const tSub = randomUUID(); const pSub = await seedPipeline(tenant, req, tSub, 'qualified');
      await seedSubmittal(tenant, tSub, req, 'submitted_to_ats', pSub, null); // post-submit, client owns next

      const board = await call(tenant, req);
      expect(board.closed.total).toBe(1);
      const submittedCard = anyCard(board, tSub)!;
      expect(submittedCard.column).toBe('submitted');
      expect(submittedCard.next_actions).toEqual([]); // no bounded Board command at the submittal handoff
    });
  },
);
