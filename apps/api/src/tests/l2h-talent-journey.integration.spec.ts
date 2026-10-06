import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARAMO_POSTGRES_TEST_IMAGE, AramoError } from '@aramo/common';
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
import { DocumentsRepository, DocumentIdempotencyService, PrismaService as DocumentsPrismaService } from '@aramo/documents';

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
  ...migrationsFor('documents'),
];

// Dollar-quote-, line-comment- AND single-quote-string-aware DDL splitter. A `;` inside a
// '...' string literal (e.g. the DOC-6 OFFER_LETTER seed's prose) must NOT split the
// statement; '' is the SQL escape for a literal quote. Single quotes inside a $$ body stay
// protected by inDollar (never treated as a string delimiter).
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  let inLineComment = false;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) { cur += ch; if (ch === '\n') inLineComment = false; continue; }
    if (inString) {
      cur += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { cur += "'"; i += 1; } // escaped '' — remain in string
        else inString = false;
      }
      continue;
    }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') { inLineComment = true; cur += ch; continue; }
    if (!inDollar && ch === "'") { inString = true; cur += ch; continue; }
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
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
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
      const documentsPrisma = new DocumentsPrismaService(url);
      for (const p of [pipelinePrisma, submittalPrisma, csPrisma, placementPrisma, preStartPrisma, documentsPrisma]) {
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
        new DocumentsRepository(documentsPrisma, new DocumentIdempotencyService(documentsPrisma)),
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
    async function seedPlacement(tenant: string, submittal: string, req: string, talent: string, state: string, kind: string | null = null): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO placement."PlacementProcess"
           (id, tenant_id, submittal_id, requisition_id, talent_record_id, state, placement_kind, offered_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::"placement"."PlacementState",$7,now(),now())`,
        [id, tenant, submittal, req, talent, state, kind],
      );
      return id;
    }

    async function seedOfferLetterDocument(tenant: string, offerId: string, status: string): Promise<string> {
      const docId = randomUUID();
      await db.query(
        `INSERT INTO documents."Document" (id, tenant_id, document_type_id, title, status, execution_mode, source_kind, created_by)
         VALUES ($1,$2,'d0c50006-0000-7000-8000-000000000001','Offer Letter',$3,'SINGLE_SIGNATURE','TEMPLATE_GENERATED',$4)`,
        [docId, tenant, status, randomUUID()],
      );
      await db.query(
        `INSERT INTO documents."DocumentAssociation" (id, tenant_id, document_id, resource_type, resource_id, relationship, created_by)
         VALUES ($1,$2,$3,'OFFER',$4,'REGARDING',$5)`,
        [randomUUID(), tenant, docId, offerId, randomUUID()],
      );
      return docId;
    }

    // §7 — a raw pre-start requirement instance for a placement (owner-authoritative row). All
    // snapshot columns are TEXT; satisfaction_policy defaults SELF_ATTEST. No materialization-intent
    // is needed: assessBlocking treats "≥1 instance" as materialized.
    async function seedRequirement(
      tenant: string,
      placementId: string,
      opts: { type: string; label: string; blocking: boolean; status: string; owner_role?: string | null },
    ): Promise<string> {
      const id = randomUUID();
      // CHECK: SATISFIED/WAIVED/CANCELED require completed_at NOT NULL (resolved_completed_at_chk).
      const resolvedAt = ['SATISFIED', 'WAIVED', 'CANCELED'].includes(opts.status) ? new Date('2026-10-02T00:00:00.000Z') : null;
      await db.query(
        `INSERT INTO pre_start_requirement."PreStartRequirementInstance"
           (id, tenant_id, placement_process_id, definition_set_id, definition_set_version, definition_set_checksum,
            requirement_definition_id, requirement_type, label, blocking, owner_role, waiver_mode, status, completed_at, completed_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'1.0.0','chk',$5,$6,$7,$8,$9,'NOT_WAIVABLE',$10,$11,$12,now(),now())`,
        [id, tenant, placementId, randomUUID(), randomUUID(), opts.type, opts.label, opts.blocking, opts.owner_role ?? null, opts.status, resolvedAt, resolvedAt === null ? null : randomUUID()],
      );
      return id;
    }

    const call = (tenant: string, pipelineId: string, vis: ReadonlySet<string> | null = null) =>
      service.getJourney({ tenant_id: tenant, pipeline_id: pipelineId, visible_requisition_ids: vis, requestId: 'r' });
    const callWithDoc = (tenant: string, pipelineId: string) =>
      service.getJourney({ tenant_id: tenant, pipeline_id: pipelineId, visible_requisition_ids: null, include_offer_document: true, requestId: 'r' });
    const callWithPreStart = (tenant: string, pipelineId: string) =>
      service.getJourney({ tenant_id: tenant, pipeline_id: pipelineId, visible_requisition_ids: null, include_pre_start: true, requestId: 'r' });

    // ---------------------------------------------------------------------------------------
    // AC-2a — an ACCEPTED offer with NO established placement reads OFFER, not ACCEPTED_PLACED.
    // ---------------------------------------------------------------------------------------
    it('AC-2a: ACCEPTED offer + no placement → current_journey_stage=OFFER (fill = establishment, not offer-acceptance)', async () => {
      const tenant = randomUUID(); const talent = randomUUID();
      const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_client');
      await seedOffer(tenant, sub, req, talent, 'ACCEPTED', null);

      const j = await call(tenant, pipe);
      expect(j.current_journey_stage).toBe('OFFER');
      expect(j.sub_states.offer_state).toBe('ACCEPTED');
      expect(j.sub_states.placement_state).toBeNull(); // BEFORE: no placement established
      // Negative control: it did NOT derive ACCEPTED_PLACED from an accepted offer.
      expect(j.stages.some((s) => s.stage === 'ACCEPTED_PLACED')).toBe(false);
    });

    // ---------------------------------------------------------------------------------------
    // Offer & Start §6.7 — the OPT-IN offer-letter DOCUMENT signal, DB-derived from
    // Document.status, kept DISTINCT from the Offer ACCEPTED business fact (§2.5). Opt-out
    // (the shared Talent 360 hot read) omits it entirely (D-ARCH-1).
    // ---------------------------------------------------------------------------------------
    it('§6.7: include_offer_document composes the offer-letter signal (PREPARED→AWAITING_SIGNATURE) with documents provenance; opt-out omits it', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_client');
      const offerId = await seedOffer(tenant, sub, req, talent, 'SENT', 'summary');
      const docId = await seedOfferLetterDocument(tenant, offerId, 'PREPARED');

      const withDoc = await callWithDoc(tenant, pipe);
      expect(withDoc.offer_document).toEqual({ owner: 'documents', document_id: docId, status: 'AWAITING_SIGNATURE' });
      expect(withDoc.sub_states.offer_state).toBe('SENT'); // §2.5 — document progress ≠ acceptance

      const withoutDoc = await call(tenant, pipe); // default (no opt-in) → absent
      expect(withoutDoc.offer_document).toBeNull();
    });

    it('§6.7/§2.5: an EXECUTED offer-letter reads EXECUTED (document signed) while the offer is still SENT (not accepted)', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_client');
      const offerId = await seedOffer(tenant, sub, req, talent, 'SENT', null);
      await seedOfferLetterDocument(tenant, offerId, 'EXECUTED');

      const j = await callWithDoc(tenant, pipe);
      expect(j.offer_document?.status).toBe('EXECUTED'); // signed = durable e-sign evidence
      expect(j.sub_states.offer_state).toBe('SENT');      // acceptance is the separate Offer fact
    });

    // ---------------------------------------------------------------------------------------
    // AC-2b — a STARTED placement reads STARTED even while the Pipeline row is still at a live
    // recruiting status (`qualified`): the downstream owner drives the journey, not the Pipeline.
    // ---------------------------------------------------------------------------------------
    it('AC-2b: STARTED placement + live pipeline `qualified` → current_journey_stage=STARTED (downstream owns it)', async () => {
      const tenant = randomUUID(); const talent = randomUUID();
      const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified'); // most-advanced Pipeline-owned status
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_client');
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
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_client');
      await seedPlacement(tenant, sub, req, talent, 'PRE_START');

      const j = await call(tenant, pipe);
      expect(j.current_journey_stage).toBe('PRE_START'); // downstream placement owner drives it, over pipeline `qualified`
      expect(j.sub_states.placement_state).toBe('PRE_START');
    });

    // ---------------------------------------------------------------------------------------
    // §7 Pre-start Readiness — the opt-in composed section: generic rows, authoritative
    // readiness (assessBlocking), display-only N-of-M, governed ready action, needs-attention.
    // ---------------------------------------------------------------------------------------
    it('§7: include_pre_start composes generic requirement rows + display-only N-of-M + authoritative NOT-ready (one unresolved blocking) → no ready action', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_client');
      const placement = await seedPlacement(tenant, sub, req, talent, 'PRE_START');
      await seedRequirement(tenant, placement, { type: 'SIGNED_OFFER', label: 'Signed offer', blocking: true, status: 'SATISFIED', owner_role: 'recruiter' });
      await seedRequirement(tenant, placement, { type: 'I9', label: 'Work authorization / I-9', blocking: true, status: 'PENDING', owner_role: 'compliance' });

      const j = await callWithPreStart(tenant, pipe);
      expect(j.pre_start).not.toBeNull();
      const ps = j.pre_start!;
      expect(ps.placement_process_id).toBe(placement);
      expect(ps.summary).toEqual({ complete: 1, total: 2 });
      expect(ps.readiness).toEqual({ materialized: true, ready: false });
      expect(ps.ready_to_start_action).toBeNull(); // fail-closed: an unresolved blocking requirement
      expect(ps.needs_attention).toHaveLength(0); // PENDING is normal onboarding, not a blocker (§7.6)
      // generic rows carry authoritative label/status/owner; remediation ONLY while unresolved.
      const i9 = ps.requirements.find((r) => r.id !== null && r.label.startsWith('Work'))!;
      expect(i9.status).toBe('PENDING');
      expect(i9.owner_role).toBe('compliance');
      expect(i9.remediation?.command_route).toBe(`POST /v1/pre-start-requirement/requirements/${i9.id}/status`);
      const signed = ps.requirements.find((r) => r.label === 'Signed offer')!;
      expect(signed.status).toBe('SATISFIED');
      expect(signed.remediation).toBeNull(); // resolved → not actionable here
    });

    it('§7.5: all blocking requirements resolved → authoritative ready + governed markReadyToStart action (named, not issued)', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_client');
      const placement = await seedPlacement(tenant, sub, req, talent, 'PRE_START');
      await seedRequirement(tenant, placement, { type: 'SIGNED_OFFER', label: 'Signed offer', blocking: true, status: 'SATISFIED' });
      await seedRequirement(tenant, placement, { type: 'NDA', label: 'Client NDA', blocking: true, status: 'WAIVED' });

      const ps = (await callWithPreStart(tenant, pipe)).pre_start!;
      expect(ps.readiness).toEqual({ materialized: true, ready: true });
      expect(ps.summary).toEqual({ complete: 2, total: 2 });
      expect(ps.ready_to_start_action).toEqual({ action: 'Mark ready to start', owner: 'pre-start', command_route: `POST /v1/pre-start-requirement/placements/${placement}/ready` });
    });

    it('§7.6: a FAILED blocking requirement appears in needs_attention (authoritative blocker projection)', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_client');
      const placement = await seedPlacement(tenant, sub, req, talent, 'BLOCKED');
      await seedRequirement(tenant, placement, { type: 'BACKGROUND', label: 'Background check', blocking: true, status: 'FAILED' });

      const ps = (await callWithPreStart(tenant, pipe)).pre_start!;
      expect(ps.readiness.ready).toBe(false);
      expect(ps.needs_attention.map((r) => r.label)).toEqual(['Background check']);
      expect(ps.ready_to_start_action).toBeNull();
    });

    it('§7: opt-out (no include_pre_start) omits the section even with a placement + requirements (hot-read discipline)', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_client');
      const placement = await seedPlacement(tenant, sub, req, talent, 'PRE_START');
      await seedRequirement(tenant, placement, { type: 'SIGNED_OFFER', label: 'Signed offer', blocking: true, status: 'PENDING' });

      const j = await call(tenant, pipe); // default: no include_pre_start
      expect(j.pre_start).toBeNull();
    });

    it('§8: placement is composed once a placement exists; a legacy NULL placement_kind normalizes to CONTRACT', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_client');
      const placement = await seedPlacement(tenant, sub, req, talent, 'READY_TO_START'); // kind NULL
      const j = await call(tenant, pipe);
      expect(j.placement).toEqual({ id: placement, kind: 'CONTRACT' });
    });

    it('§8.3: an explicit PERMANENT placement composes kind=PERMANENT (direct-hire branch)', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_client');
      const placement = await seedPlacement(tenant, sub, req, talent, 'STARTED', 'PERMANENT');
      const j = await call(tenant, pipe);
      expect(j.placement).toEqual({ id: placement, kind: 'PERMANENT' });
    });

    it('§8: no placement → placement is null', async () => {
      const tenant = randomUUID(); const talent = randomUUID(); const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const j = await call(tenant, pipe);
      expect(j.placement).toBeNull();
    });

    // ---------------------------------------------------------------------------------------
    // AC-1 — SUBMITTED attributes to Submittal (not Pipeline); every stage has owner + source id.
    // ---------------------------------------------------------------------------------------
    it('AC-1: SUBMITTED stage attributes to Submittal; every stage carries owner + resolving source_object_id', async () => {
      const tenant = randomUUID(); const talent = randomUUID();
      const req = randomUUID();
      const pipe = await seedPipeline(tenant, req, talent, 'qualified');
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_client');

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
      const s1 = await seedSubmittal(t1, talent1, r1, 'submitted_to_client');
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
      const s2 = await seedSubmittal(t2, talent2, r2, 'submitted_to_client');
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
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_client');
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
      const sub = await seedSubmittal(tenant, talent, req, 'submitted_to_client');
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
