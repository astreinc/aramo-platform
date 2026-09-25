import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import { PipelineRepository, PipelinePrismaService } from '@aramo/pipeline';
import { SubmittalRepository, PrismaService as SubmittalPrismaService } from '@aramo/submittal';
import { ClientSelectionProcessRepository, ClientSelectionPrismaService } from '@aramo/client-selection';
import { OfferRepository, PlacementRepository, PrismaService as PlacementPrismaService } from '@aramo/placement';
import { RequisitionSubmittalEligibilityReader, PrismaService as EligibilityPrismaService } from '@aramo/submittal-eligibility';
import { RequisitionAssignmentRepository, RequisitionPrismaService } from '@aramo/requisition';
import { DocumentsRepository, DocumentIdempotencyService, PrismaService as DocumentsPrismaService } from '@aramo/documents';
import { ClientTalentRestrictionRepository, PrismaService as CtrPrismaService } from '@aramo/client-talent-restriction';

import { RequisitionTalentBoardReadService } from '../requisition-talent-board/requisition-talent-board-read.service.js';
import { DocumentReadinessGate, RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/document-readiness.gate.js';
import type { EngagementGateService } from '../engagement/engagement-gate.service.js';

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
  ...migrationsFor('documents'),
  ...migrationsFor('client-talent-restriction'),
];

// Dollar-quote-, single-quote- AND line-comment-aware DDL splitter (the comment-blind-splitter
// trap + the DOC-6 seed carries a `;` inside a single-quoted description string).
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  let inLineComment = false;
  let inString = false; // inside a '...' string literal
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) { cur += ch; if (ch === '\n') inLineComment = false; continue; }
    if (inString) {
      cur += ch;
      // '' is an escaped quote (stays in the string); a lone ' closes it.
      if (ch === "'") { if (sql[i + 1] === "'") { cur += "'"; i += 1; } else { inString = false; } }
      continue;
    }
    if (!inDollar && ch === "'") { inString = true; cur += ch; continue; }
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
    let documentReadiness: DocumentReadinessGate;
    let restrictionRepo: ClientTalentRestrictionRepository;
    const prismas: Array<{ $disconnect: () => Promise<void> }> = [];
    // TB-4 harness controls: the requisition→company_id map (a trivial select, stubbed for
    // harness simplicity; the restriction READER + rows are REAL) and the engagement-gate
    // applicability (its own 3-state resolution is a separate unit concern — here we drive the
    // board's HANDLING of each verdict deterministically).
    const companyIdByReq = new Map<string, string | null>();
    let engagementMode: 'dormant' | 'policy_missing' | 'policy_present' = 'dormant';
    // Accidental-Add — talents with a requisition interaction (controls the VOID-action gate;
    // the REAL comms reader is proven end-to-end in the VOID orchestrator integration spec).
    const engagedTalentSet = new Set<string>();

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
      const documentsPrisma = new DocumentsPrismaService(url);
      const ctrPrisma = new CtrPrismaService(url);
      for (const p of [pipelinePrisma, submittalPrisma, csPrisma, placementPrisma, eligibilityPrisma, requisitionPrisma, documentsPrisma, ctrPrisma]) {
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
      const docsRepo = new DocumentsRepository(documentsPrisma, new DocumentIdempotencyService(documentsPrisma) as never);
      documentReadiness = new DocumentReadinessGate(docsRepo);
      restrictionRepo = new ClientTalentRestrictionRepository(ctrPrisma as never, NOOP_LOGGER);
      // Trivial company_id select — stubbed (the restriction READER + seeded rows are real).
      const requisitionsStub = {
        findCompanyId: async (a: { tenant_id: string; id: string }): Promise<string | null> =>
          companyIdByReq.get(a.id) ?? null,
      } as unknown as ConstructorParameters<typeof RequisitionTalentBoardReadService>[8];
      // Engagement applicability — driven per test (dormant | policy_missing | policy_present).
      const engagementStub = {
        resolveApplicability: async (): Promise<'dormant' | 'policy_missing' | 'policy_present'> => engagementMode,
      } as unknown as EngagementGateService;
      const commsStub = {
        findTalentIdsWithRequisitionInteractions: async (a: { talent_record_ids: readonly string[] }): Promise<Set<string>> =>
          new Set(a.talent_record_ids.filter((t) => engagedTalentSet.has(t))),
      } as unknown as ConstructorParameters<typeof RequisitionTalentBoardReadService>[11];
      service = new RequisitionTalentBoardReadService(
        pipelineRepo,
        submittalRepo,
        selectionRepo,
        offerRepo,
        placementRepo,
        readinessReader,
        assignmentRepo,
        documentReadiness,
        requisitionsStub,
        restrictionRepo,
        engagementStub,
        commsStub,
        NOOP_LOGGER,
      );
    }, 240_000);

    beforeEach(() => {
      companyIdByReq.clear();
      engagementMode = 'dormant';
      engagedTalentSet.clear();
    });

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
    // TB-4 — an RTR DocumentRequirement makes the DOC-5 gate CONDITIONALLY apply to a requisition.
    async function seedRtrRequirement(tenant: string, req: string): Promise<void> {
      await db.query(
        `INSERT INTO documents."DocumentRequirement"
           (id, tenant_id, document_type_id, resource_type, resource_id, relationship, status, created_by)
         VALUES ($1,$2,$3,'REQUISITION',$4,'REGARDING','UNSATISFIED',$5)`,
        [randomUUID(), tenant, RIGHT_TO_REPRESENT_TYPE_ID, req, randomUUID()],
      );
    }
    // TB-4 — an ACTIVE client-talent restriction (the requisition's company_id must be wired via
    // companyIdByReq so the composer resolves the same client company).
    async function seedRestriction(tenant: string, companyId: string, talent: string): Promise<void> {
      await db.query(
        `INSERT INTO client_talent_restriction."ClientTalentRestriction"
           (id, tenant_id, client_company_id, talent_record_id, source_reference, reason_code, recorded_by,
            effective_from, restriction_type, asserted_by_type, source_system, recorded_at)
         VALUES ($1,$2,$3,$4,$5,'client_do_not_resubmit',$6, TIMESTAMPTZ '2026-01-01T00:00:00Z',
                 'CLIENT_DO_NOT_RESUBMIT'::"client_talent_restriction"."RestrictionType",
                 'CLIENT'::"client_talent_restriction"."AssertedByType",
                 'CLIENT_EMAIL'::"client_talent_restriction"."SourceSystem", now())`,
        [randomUUID(), tenant, companyId, talent, `src-${randomUUID()}`, randomUUID()],
      );
    }
    // TB-4 — an EXECUTED RTR document jointly associated to (talent SUBJECT, requisition REGARDING).
    async function seedExecutedRtr(tenant: string, req: string, talent: string): Promise<void> {
      const docId = randomUUID();
      await db.query(
        `INSERT INTO documents."Document"
           (id, tenant_id, document_type_id, title, status, execution_mode, source_kind, created_by, executed_at)
         VALUES ($1,$2,$3,'RTR','EXECUTED','SINGLE_SIGNATURE','TEMPLATE_GENERATED',$4,now())`,
        [docId, tenant, RIGHT_TO_REPRESENT_TYPE_ID, randomUUID()],
      );
      for (const [rtype, rid, rel] of [['REQUISITION', req, 'REGARDING'], ['TALENT', talent, 'SUBJECT']] as const) {
        await db.query(
          `INSERT INTO documents."DocumentAssociation" (id, tenant_id, document_id, resource_type, resource_id, relationship, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), tenant, docId, rtype, rid, rel, randomUUID()],
        );
      }
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

    // ---------------------------------------------------------------------------------------
    // TB4-1 — the Qualified band is re-grounded on the REAL evaluateEligibility port: with NO
    // policy row (open window) and NO RTR requirement (ungated) + a résumé → ready_to_submit.
    // ---------------------------------------------------------------------------------------
    it('TB4-1: open window + RTR not required + résumé → ready_to_submit (via the real eligibility port)', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      await seedPipeline(tenant, req, talent, 'qualified');
      await seedResume(tenant, talent, req, randomUUID(), new Date('2026-01-10T00:00:00Z'));

      const board = await call(tenant, req);
      const card = cardsIn(board, 'qualified')[0]!;
      expect(card.readiness?.band).toBe('ready_to_submit');
      expect(card.readiness?.blockers).toEqual([]);
      expect(card.rtr_state).toBeNull(); // ungated — no RTR concern
    });

    // ---------------------------------------------------------------------------------------
    // TB4-2 — RTR REQUIRED for the requisition but NOT executed for the talent → the port denies:
    // needs_action + the canonical rtr_not_executed blocker + rtr_state NOT_EXECUTED.
    // ---------------------------------------------------------------------------------------
    it('TB4-2: RTR required + not executed → needs_action + rtr_not_executed (DOC-5 gate via the port)', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      await seedPipeline(tenant, req, talent, 'qualified');
      await seedResume(tenant, talent, req, randomUUID(), new Date('2026-01-10T00:00:00Z'));
      await seedRtrRequirement(tenant, req); // gate now applies; no executed RTR seeded

      const board = await call(tenant, req);
      const card = cardsIn(board, 'qualified')[0]!;
      expect(card.readiness?.band).toBe('needs_action');
      expect(card.readiness?.blockers).toContain('rtr_not_executed');
      expect(card.rtr_state).toBe('NOT_EXECUTED');
    });

    // ---------------------------------------------------------------------------------------
    // TB4-3 — RTR required AND executed for the exact (talent, requisition) → the port is
    // satisfied → ready_to_submit; no RTR blocker; rtr_state clears.
    // ---------------------------------------------------------------------------------------
    it('TB4-3: RTR required + executed for the exact (talent, requisition) → ready_to_submit', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      await seedPipeline(tenant, req, talent, 'qualified');
      await seedResume(tenant, talent, req, randomUUID(), new Date('2026-01-10T00:00:00Z'));
      await seedRtrRequirement(tenant, req);
      await seedExecutedRtr(tenant, req, talent);

      const board = await call(tenant, req);
      const card = cardsIn(board, 'qualified')[0]!;
      expect(card.readiness?.band).toBe('ready_to_submit');
      expect(card.readiness?.blockers).toEqual([]);
      expect(card.rtr_state).toBeNull();
    });

    // ---------------------------------------------------------------------------------------
    // TB4-4 (remediation) — an ACTIVE client restriction authoritatively blocks Ready: the band
    // is NEEDS ACTION with client_restricted (never a false-positive Ready). REAL restriction row.
    // ---------------------------------------------------------------------------------------
    it('TB4-4: an active client restriction → NEEDS ACTION + client_restricted (authoritative, never Ready)', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID(); const company = randomUUID();
      companyIdByReq.set(req, company);
      await seedPipeline(tenant, req, talent, 'qualified');
      await seedResume(tenant, talent, req, randomUUID(), new Date('2026-01-10T00:00:00Z'));
      await seedRestriction(tenant, company, talent); // ACTIVE restriction at this client

      const board = await call(tenant, req);
      const card = cardsIn(board, 'qualified')[0]!;
      expect(card.readiness?.band).toBe('needs_action');
      expect(card.readiness?.blockers).toContain('client_restricted');
    });

    // ---------------------------------------------------------------------------------------
    // TB4-5 (remediation) — engagement policy MISSING (governed tenant, no effective policy) →
    // authoritative fail-closed: NEEDS ACTION + engagement_policy_missing, never Ready.
    // ---------------------------------------------------------------------------------------
    it('TB4-5: engagement policy missing → NEEDS ACTION + engagement_policy_missing (never Ready)', async () => {
      engagementMode = 'policy_missing';
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      await seedPipeline(tenant, req, talent, 'qualified');
      await seedResume(tenant, talent, req, randomUUID(), new Date('2026-01-10T00:00:00Z'));

      const board = await call(tenant, req);
      const card = cardsIn(board, 'qualified')[0]!;
      expect(card.readiness?.band).toBe('needs_action');
      expect(card.readiness?.blockers).toContain('engagement_policy_missing');
    });

    // ---------------------------------------------------------------------------------------
    // TB4-6 (remediation) — an engagement policy is PRESENT but its per-talent verdict is not
    // batch-evaluable → readiness UNAVAILABLE → NEEDS ACTION, NEVER a false-positive Ready even
    // when every other gate is satisfied (the exact anti-false-positive invariant).
    // ---------------------------------------------------------------------------------------
    it('TB4-6: engagement policy present (per-talent unavailable) → NEEDS ACTION + engagement_readiness_unavailable, never Ready', async () => {
      engagementMode = 'policy_present';
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      await seedPipeline(tenant, req, talent, 'qualified');
      await seedResume(tenant, talent, req, randomUUID(), new Date('2026-01-10T00:00:00Z')); // everything else clear

      const board = await call(tenant, req);
      const card = cardsIn(board, 'qualified')[0]!;
      expect(card.readiness?.band).toBe('needs_action'); // NOT ready — engagement unproven
      expect(card.readiness?.blockers).toEqual(['engagement_readiness_unavailable']);
    });

    // ---------------------------------------------------------------------------------------
    // TB4-7 (remediation) — live re-decision: a card Ready on preflight flips to NOT ready once a
    // restriction lands (proves the band is a LIVE authoritative read, not a cached assertion; the
    // submit transaction re-evaluates the same gates transactionally at mutation time).
    // ---------------------------------------------------------------------------------------
    it('TB4-7: preflight Ready then a restriction lands → re-read is NOT ready (live re-decision)', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID(); const company = randomUUID();
      companyIdByReq.set(req, company);
      await seedPipeline(tenant, req, talent, 'qualified');
      await seedResume(tenant, talent, req, randomUUID(), new Date('2026-01-10T00:00:00Z'));

      const before = await call(tenant, req);
      expect(cardsIn(before, 'qualified')[0]!.readiness?.band).toBe('ready_to_submit');
      await seedRestriction(tenant, company, talent); // authoritative fact changes
      const after = await call(tenant, req);
      expect(cardsIn(after, 'qualified')[0]!.readiness?.band).toBe('needs_action');
      expect(cardsIn(after, 'qualified')[0]!.readiness?.blockers).toContain('client_restricted');
    });

    // ---------------------------------------------------------------------------------------
    // TB4-8 (remediation) — the same Talent facts under a DIFFERENT requisition policy yield a
    // different readiness: an open-window requisition is Ready; a PAUSED-window one is NEEDS
    // ACTION (submittals_closed), proving policy — not the Board — drives readiness.
    // ---------------------------------------------------------------------------------------
    it('TB4-8: same facts, different requisition policy → different readiness (policy drives it)', async () => {
      const tenant = randomUUID();
      const reqOpen = randomUUID(); const tOpen = randomUUID();
      await seedPipeline(tenant, reqOpen, tOpen, 'qualified');
      await seedResume(tenant, tOpen, reqOpen, randomUUID(), new Date('2026-01-10T00:00:00Z'));
      const reqPaused = randomUUID(); const tPaused = randomUUID();
      await seedPipeline(tenant, reqPaused, tPaused, 'qualified');
      await seedResume(tenant, tPaused, reqPaused, randomUUID(), new Date('2026-01-10T00:00:00Z'));
      // A PAUSED submittal policy on the second requisition (manual_override = PAUSED).
      await db.query(
        `INSERT INTO submittal_policy."RequisitionSubmittalPolicy" (id, tenant_id, requisition_id, manual_override, updated_at)
         VALUES ($1,$2,$3,'PAUSED'::"submittal_policy"."SubmittalWindowStatus", now())`,
        [randomUUID(), tenant, reqPaused],
      );

      expect(cardsIn(await call(tenant, reqOpen), 'qualified')[0]!.readiness?.band).toBe('ready_to_submit');
      const paused = cardsIn(await call(tenant, reqPaused), 'qualified')[0]!;
      expect(paused.readiness?.band).toBe('needs_action');
      expect(paused.readiness?.blockers).toContain('submittals_closed');
    });

    // ---------------------------------------------------------------------------------------
    // TB6-1 — the DERIVED downstream-handoff marker: cards at/before Client Selected are
    // Board-owned (handoff=false); cards past the §3.2 boundary (Offer onward) are handoff=true.
    // ---------------------------------------------------------------------------------------
    it('TB6-1: handoff is false up to Client Selected and true for Offer/Placement (derived boundary)', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      // A recruiting-lane card (qualified) — Board-owned.
      const tQ = randomUUID(); await seedPipeline(tenant, req, tQ, 'qualified');
      // A Client-Selected card — the LAST Board-owned column (handoff point, not yet handoff).
      const tS = randomUUID(); const pS = await seedPipeline(tenant, req, tS, 'qualified');
      const sS = await seedSubmittal(tenant, tS, req, 'submitted_to_ats', pS, null);
      await seedSelection(tenant, sS, req, tS, 'SELECTED');
      // A Started placement — downstream/handoff.
      const tP = randomUUID(); const pP = await seedPipeline(tenant, req, tP, 'qualified');
      const sP = await seedSubmittal(tenant, tP, req, 'submitted_to_ats', pP, null);
      await seedPlacement(tenant, sP, req, tP, 'STARTED');

      const board = await call(tenant, req);
      expect(anyCard(board, tQ)!.handoff).toBe(false);
      expect(anyCard(board, tS)!.handoff).toBe(false); // Client Selected is the handoff point, still Board-owned
      expect(anyCard(board, tP)!.handoff).toBe(true); // Started — downstream, tracked read-only
      // A handoff card is never governed-draggable / never carries a bounded Board action.
      expect(anyCard(board, tP)!.next_actions).toEqual([]);
    });

    // ---------------------------------------------------------------------------------------
    // PC2-BOARD-1 (Accidental-Add) — a voided episode is DROPPED from the Board entirely:
    // not an active card, and NOT counted in Closed (§11/§16).
    // ---------------------------------------------------------------------------------------
    it('PC2-BOARD-1: a voided episode is excluded from active columns AND from Closed counts', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      const active = randomUUID(); await seedPipeline(tenant, req, active, 'qualified');
      const voided = randomUUID(); await seedPipeline(tenant, req, voided, 'voided');
      const disp = randomUUID(); await seedPipeline(tenant, req, disp, 'not_in_consideration');

      const board = await call(tenant, req);
      expect(board.total_active).toBe(1); // only the qualified card
      expect(anyCard(board, voided)).toBeUndefined(); // voided is not on the Board
      expect(board.closed.total).toBe(1); // ONLY the real disposition — voided never inflates Closed
      expect(board.closed.by_reason.find((r) => r.reason === 'not_in_consideration')?.count).toBe(1);
    });

    // ---------------------------------------------------------------------------------------
    // PC2-BOARD-2 (Accidental-Add) — the "Remove from requisition" (pipeline.void) action is
    // projected on a no_contact card ONLY when the backend deems it eligible: no engagement.
    // ---------------------------------------------------------------------------------------
    it('PC2-BOARD-2: pipeline.void projected on a clean no_contact card; HIDDEN once engagement exists', async () => {
      const tenant = randomUUID(); const req = randomUUID();
      const clean = randomUUID(); await seedPipeline(tenant, req, clean, 'no_contact');
      const engaged = randomUUID(); await seedPipeline(tenant, req, engaged, 'no_contact');
      engagedTalentSet.add(engaged); // this Talent has a requisition interaction

      const board = await call(tenant, req);
      const cleanCard = cardsIn(board, 'pipeline').find((c) => c.talent_record_id === clean)!;
      expect(cleanCard.next_actions.map((a) => a.key)).toContain('pipeline.void');
      expect(cleanCard.next_actions.find((a) => a.key === 'pipeline.void')!.command_route).toBe(`POST /v1/pipelines/${cleanCard.pipeline_id}/void`);
      const engagedCard = cardsIn(board, 'pipeline').find((c) => c.talent_record_id === engaged)!;
      expect(engagedCard.next_actions.map((a) => a.key)).not.toContain('pipeline.void'); // hidden — server-authoritative
    });
  },
);
