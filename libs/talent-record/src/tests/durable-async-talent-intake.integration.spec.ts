import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';
import {
  PrismaService as EvidencePrismaService,
  TalentEvidenceRepository,
} from '@aramo/talent-evidence';
import { TalentExtractionService } from '@aramo/talent-extraction';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentRecordRepository } from '../lib/talent-record.repository.js';
import { TalentCreateFromDraftService } from '../lib/talent-create-from-draft.service.js';
import { ResumeExtractionDraftProcessor } from '../lib/resume-extraction-draft/resume-extraction-draft.processor.js';
import { TalentIntakeRelayProcessor } from '../lib/talent-intake/talent-intake-relay.processor.js';
import { TalentIntakeService } from '../lib/talent-intake/talent-intake.service.js';
import { TalentIntakePromotionService } from '../lib/talent-intake/talent-intake-promotion.service.js';
import { intakeExtractJobId } from '../lib/talent-intake/talent-intake.constants.js';

// Durable Async Résumé-First Talent Intake — the RELEASE-BLOCKING runtime spine
// proof against a real Postgres 17. It drives the SAME relay/enqueue/worker
// mechanism the running system uses (the scheduled ticks call these exact
// methods); only the BullMQ broker, S3, and the governed LLM are faked. The
// extraction ORCHESTRATOR is stubbed (its S3+LLM boundary) so the proof is about
// the durability/promotion machinery, not the unchanged extractor.
//
// Proves, in one coherent flow + explicit detail checks:
//   create → upload/commit → complete-upload(202) → outbox row exists →
//   relay enqueues (jobId derived from the outbox event id) → worker processes →
//   ResumeExtractionDraft CHILD → READY_FOR_REVIEW → TalentIntakeDraft PARENT →
//   READY → GET returns persisted draft → PATCH persists recruiter edits →
//   promote creates EXACTLY ONE TalentRecord → second promote converges.
// Plus: no browser state after complete-upload; parent is never the evidence
// authority; review survives reload; stale PATCH → 409; retry reuses the same
// artifact; missing admission fields → 422 details.missing; tenant mismatch
// cannot read/promote; promotion is replay-idempotent; promoted_talent_record_id
// persists on the parent after canonical creation.

// Three schemas participate (talent_record, talent_evidence, documents). Merge
// every migration dir and apply in global chronological order (directory
// timestamp prefix), so documents init precedes the talent-evidence doc1b
// reconcile, etc.
const MIGRATION_DIRS = [
  resolve(__dirname, '../../prisma/migrations'),
  resolve(__dirname, '../../../talent-evidence/prisma/migrations'),
  resolve(__dirname, '../../../documents/prisma/migrations'),
];

function collectMigrations(): string[] {
  const all: { name: string; path: string }[] = [];
  for (const dir of MIGRATION_DIRS) {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && /^\d+_/.test(d.name)) {
        all.push({ name: d.name, path: resolve(dir, d.name, 'migration.sql') });
      }
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name)).map((m) => m.path);
}

// Dollar-quote-aware DDL splitter — the documents migrations carry `$$`-quoted
// trigger-function bodies (append-only guards) that the comment-blind precedent
// splitter would break at the `;` inside the body. Tracks line comments,
// single-quote string literals, and `$tag$...$tag$` blocks; only splits on a
// top-level `;`.
function splitDdl(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  let dollarTag: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollarTag === null && ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      current += '\n';
      i = nl + 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m !== null) {
        const tag = m[0];
        if (dollarTag === null) {
          dollarTag = tag;
          current += tag;
          i += tag.length;
          continue;
        }
        if (dollarTag === tag) {
          dollarTag = null;
          current += tag;
          i += tag.length;
          continue;
        }
      }
    }
    if (dollarTag === null && ch === "'") {
      current += ch;
      i += 1;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (dollarTag === null && ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const last = current.trim();
  if (last.length > 0) {
    statements.push(last);
  }
  return statements;
}

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const ACTOR_A = '33333333-3333-7333-8333-333333333333';

type Auth = { tenant_id: string; sub: string };
const authA: Auth = { tenant_id: TENANT_A, sub: ACTOR_A };
const authB: Auth = { tenant_id: TENANT_B, sub: ACTOR_A };

// A deterministic grounded extraction result (the orchestrator's S3+LLM output).
function cannedResult(over: Record<string, unknown> = {}): unknown {
  return {
    prefill: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      email1: 'ada@example.com',
      phone_cell: '+15551230000',
      city: 'London',
      state: 'NA',
      title: 'Engineer',
    },
    parse_status: 'parsed',
    extraction_status: 'success',
    source_map_version: 'resume-source-map/v1',
    resume_text_hash: 'spine-hash',
    ...over,
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'durable async talent intake — runtime spine (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let evidencePrisma: EvidencePrismaService;
    let recordPrisma: PrismaService;
    let intake: TalentIntakeService;
    let promotion: TalentIntakePromotionService;
    let worker: ResumeExtractionDraftProcessor;
    let relay: TalentIntakeRelayProcessor;
    let evidenceRepo: TalentEvidenceRepository;

    // Fakes for the external boundaries only.
    const enqueued: Array<{ name: string; data: unknown; opts: { jobId?: string } }> = [];
    const fakeQueue = {
      add: async (name: string, data: unknown, opts: { jobId?: string }) => {
        enqueued.push({ name, data, opts });
      },
    };
    let orchestratorResult: unknown = cannedResult();
    const orchestratorStub = {
      extractResume: async () => orchestratorResult,
    };
    const objectStorageStub = {
      createResumePresignedPut: async (i: { tenant_id: string; talent_record_id: string; filename: string }) => ({
        storage_key: `${i.tenant_id}/talent/${i.talent_record_id}/resume/${uuidv7()}-${i.filename}`,
        presigned_url: 'https://s3/put',
        expires_at: '2030-01-01T00:00:00.000Z',
      }),
      headObject: async () => ({ byte_length: 1234, content_type: 'application/pdf' }),
      markResumeCommitted: async () => undefined,
    };
    const noop = { log: () => undefined, warn: () => undefined, error: () => undefined };
    const fakeRegistrar = { register: () => undefined };
    const fakeRedis = { isConfigured: false };

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new EvidencePrismaService(url);
      await setup.$connect();
      for (const path of collectMigrations()) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          await setup.$executeRawUnsafe(stmt);
        }
      }
      await setup.$disconnect();

      evidencePrisma = new EvidencePrismaService(url);
      recordPrisma = new PrismaService(url);
      await evidencePrisma.$connect();
      await recordPrisma.$connect();

      evidenceRepo = new TalentEvidenceRepository(evidencePrisma);
      const talentExtraction = new TalentExtractionService(
        {} as never, // aiDraft — never called (orchestrator stubbed)
        evidenceRepo,
        {} as never, // trust — never called
        {} as never, // structuredGen — never called
      );
      const recordRepo = new TalentRecordRepository(recordPrisma);
      const createFromDraft = new TalentCreateFromDraftService(
        recordRepo,
        talentExtraction,
        undefined,
        undefined,
      );

      intake = new TalentIntakeService(objectStorageStub as never, talentExtraction);
      promotion = new TalentIntakePromotionService(talentExtraction, createFromDraft, recordRepo);
      worker = new ResumeExtractionDraftProcessor(
        orchestratorStub as never,
        talentExtraction,
        fakeRegistrar as never,
        fakeRedis as never,
        noop as never,
      );
      relay = new TalentIntakeRelayProcessor(
        talentExtraction,
        fakeQueue as never,
        fakeRegistrar as never,
        fakeRedis as never,
        noop as never,
      );
    }, 240_000);

    afterAll(async () => {
      await evidencePrisma?.$disconnect();
      await recordPrisma?.$disconnect();
      await container?.stop();
    });

    it('drives the full durable spine: create → complete-upload → outbox → relay → worker → GET → PATCH → promote (one Talent) → second promote converges', async () => {
      orchestratorResult = cannedResult();
      enqueued.length = 0;

      // 1 — create intake (returns presigned upload target; no LLM work).
      const created = await intake.createIntake(
        authA,
        { filename: 'ada.pdf', content_type: 'application/pdf' },
        'req-create',
      );
      expect(created.draft_id).toBeTruthy();
      expect(created.upload_url).toBe('https://s3/put');
      expect(created.processing_status).toBe('UPLOADED');
      const draftId = created.draft_id;

      // 2 — complete upload → QUEUED + outbox, returns an accepted (202-shaped) view.
      const accepted = await intake.completeUpload(authA, draftId, {}, 'req-complete');
      expect(accepted.draft_id).toBe(draftId);
      expect(accepted.processing_status).toBe('QUEUED');

      // Outbox row exists (unpublished) and carries the draft id.
      const outboxBefore = await evidencePrisma.talentIntakeOutboxEvent.findMany({
        where: { tenant_id: TENANT_A, published_at: null },
      });
      expect(outboxBefore).toHaveLength(1);
      expect((outboxBefore[0].event_payload as { draft_id: string }).draft_id).toBe(draftId);
      const outboxEventId = outboxBefore[0].id;

      // ── From here NO browser/session state is used — only the persisted record
      //    drives the async spine.

      // 3 — relay enqueues an idempotent job (jobId derived from the outbox id)
      //     and publishes the row ONLY after the enqueue resolved.
      const relayResult = await relay.drainOutboxBatch({ limit: 50 });
      expect(relayResult.enqueued).toBe(1);
      expect(relayResult.published).toBe(1);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0].name).toBe('intake-extract');
      expect(enqueued[0].opts.jobId).toBe(intakeExtractJobId(outboxEventId));
      expect((enqueued[0].data as { draft_id: string }).draft_id).toBe(draftId);
      const outboxAfter = await evidencePrisma.talentIntakeOutboxEvent.findMany({
        where: { tenant_id: TENANT_A, published_at: null },
      });
      expect(outboxAfter).toHaveLength(0);

      // 4 — worker processes the enqueued job (the exact BullMQ entrypoint).
      const processed = await worker.processIntakeDraft({ draft_id: draftId, tenant_id: TENANT_A });
      expect(processed).toBe(true);

      // CHILD (ResumeExtractionDraft) reaches READY_FOR_REVIEW and holds the
      // governed result — the evidence authority.
      const child = await evidenceRepo.findResumeExtractionDraftBySource({
        tenant_id: TENANT_A,
        source_kind: 'CREATE_DRAFT_UPLOAD',
        source_ref: draftId,
      });
      expect(child).not.toBeNull();
      expect(child?.status).toBe('READY_FOR_REVIEW');
      expect(child?.structured_payload).not.toBeNull();

      // PARENT (TalentIntakeDraft) reaches READY, mirrors the prefill for review,
      // links the child, but is NOT the evidence authority.
      const afterWork = await evidenceRepo.findTalentIntakeDraftById({ tenant_id: TENANT_A, id: draftId });
      expect(afterWork?.processing_status).toBe('READY');
      expect(afterWork?.resume_extraction_draft_id).toBe(child?.id);
      expect(afterWork?.structured_payload).not.toBeNull();

      // 5 — GET returns the persisted draft (authoritative recovery read model).
      const view = await intake.get(authA, draftId, 'req-get');
      expect(view.processing_status).toBe('READY');
      expect(view.actions).toContain('promote_to_talent');
      const reviewFields = (view.review_payload as { fields: Record<string, { value: string; origin: string }> }).fields;
      expect(reviewFields['first_name'].value).toBe('Ada');
      expect(reviewFields['first_name'].origin).toBe('RESUME_EXTRACTION');

      // 6 — PATCH persists a recruiter edit (city → Oxford, origin RECRUITER).
      const edited = {
        fields: {
          ...reviewFields,
          city: { value: 'Oxford', origin: 'RECRUITER' },
        },
      };
      const patched = await intake.patchReview(
        authA,
        draftId,
        { review: edited, expected_version: afterWork!.version },
        'req-patch',
      );
      expect(patched.review_status).toBe('IN_REVIEW');

      // Survives reload.
      const reread = await intake.get(authA, draftId, 'req-get2');
      const rereadFields = (reread.review_payload as { fields: Record<string, { value: string; origin: string }> }).fields;
      expect(rereadFields['city'].value).toBe('Oxford');
      expect(rereadFields['city'].origin).toBe('RECRUITER');

      // 7 — promote creates EXACTLY ONE canonical TalentRecord.
      const talent = await promotion.promote(authA, draftId, 'req-promote');
      expect(talent.id).toBeTruthy();
      expect(talent.first_name).toBe('Ada');
      const talentRows = await recordPrisma.talentRecord.findMany({
        where: { tenant_id: TENANT_A, email1: 'ada@example.com' },
      });
      expect(talentRows).toHaveLength(1);

      // promoted_talent_record_id persists on the PARENT after canonical creation.
      const afterPromote = await evidenceRepo.findTalentIntakeDraftById({ tenant_id: TENANT_A, id: draftId });
      expect(afterPromote?.promoted_talent_record_id).toBe(talent.id);
      expect(afterPromote?.review_status).toBe('PROMOTED');

      // Evidence was established through the CHILD (resume edition exists for the
      // new Talent) — the parent never acted as the evidence authority.
      const editions = await evidencePrisma.talentResumeEdition.findMany({
        where: { tenant_id: TENANT_A, talent_id: talent.id },
      });
      expect(editions.length).toBeGreaterThanOrEqual(1);

      // 8 — second promote converges to the SAME TalentRecord (no duplicate).
      const talentAgain = await promotion.promote(authA, draftId, 'req-promote-2');
      expect(talentAgain.id).toBe(talent.id);
      const talentRowsAfter = await recordPrisma.talentRecord.findMany({
        where: { tenant_id: TENANT_A, email1: 'ada@example.com' },
      });
      expect(talentRowsAfter).toHaveLength(1);
    });

    it('stale PATCH version returns 409', async () => {
      orchestratorResult = cannedResult();
      const c = await intake.createIntake(authA, { filename: 's.pdf', content_type: 'application/pdf' }, 'r');
      await intake.completeUpload(authA, c.draft_id, {}, 'r');
      await relay.drainOutboxBatch({ limit: 50 });
      await worker.processIntakeDraft({ draft_id: c.draft_id, tenant_id: TENANT_A });
      const v = await intake.get(authA, c.draft_id, 'r');
      const currentVersion = (await evidenceRepo.findTalentIntakeDraftById({ tenant_id: TENANT_A, id: c.draft_id }))!.version;
      // A stale expected_version (current + 5) must not win.
      await expect(
        intake.patchReview(
          authA,
          c.draft_id,
          { review: v.review_payload, expected_version: currentVersion + 5 },
          'r',
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('retry reuses the SAME artifact (no re-upload) and re-queues', async () => {
      orchestratorResult = cannedResult({ parse_status: 'failed', extraction_status: 'invalid_structured_output', prefill: {} });
      const c = await intake.createIntake(authA, { filename: 'f.pdf', content_type: 'application/pdf' }, 'r');
      await intake.completeUpload(authA, c.draft_id, {}, 'r');
      await relay.drainOutboxBatch({ limit: 50 });
      await worker.processIntakeDraft({ draft_id: c.draft_id, tenant_id: TENANT_A });
      const failed = await evidenceRepo.findTalentIntakeDraftById({ tenant_id: TENANT_A, id: c.draft_id });
      expect(failed?.processing_status).toBe('FAILED');
      const storageKeyBefore = failed?.storage_key;

      const after = await intake.retry(authA, c.draft_id, 'r');
      const requeued = await evidenceRepo.findTalentIntakeDraftById({ tenant_id: TENANT_A, id: c.draft_id });
      expect(requeued?.processing_status).toBe('QUEUED');
      // Same stored artifact — retry never required a new upload.
      expect(requeued?.storage_key).toBe(storageKeyBefore);
      expect(after.processing_status).toBe('QUEUED');
    });

    it('promote with missing admission fields returns 422 with details.missing', async () => {
      // Governed result omits the admission fields → the merged review is incomplete.
      orchestratorResult = cannedResult({ prefill: { city: 'London' } });
      const c = await intake.createIntake(authA, { filename: 'm.pdf', content_type: 'application/pdf' }, 'r');
      await intake.completeUpload(authA, c.draft_id, {}, 'r');
      await relay.drainOutboxBatch({ limit: 50 });
      await worker.processIntakeDraft({ draft_id: c.draft_id, tenant_id: TENANT_A });
      await expect(promotion.promote(authA, c.draft_id, 'r')).rejects.toMatchObject({
        statusCode: 422,
        context: {
          details: {
            missing: expect.arrayContaining(['first_name', 'last_name', 'email1', 'phone_cell']),
          },
        },
      });
      // No TalentRecord was created.
      const rows = await recordPrisma.talentRecord.findMany({ where: { tenant_id: TENANT_A } });
      const forThisDraft = rows.filter((r) => r.first_name === '');
      expect(forThisDraft).toHaveLength(0);
    });

    it('tenant mismatch cannot read or promote the draft', async () => {
      orchestratorResult = cannedResult();
      const c = await intake.createIntake(authA, { filename: 't.pdf', content_type: 'application/pdf' }, 'r');
      await intake.completeUpload(authA, c.draft_id, {}, 'r');
      await relay.drainOutboxBatch({ limit: 50 });
      await worker.processIntakeDraft({ draft_id: c.draft_id, tenant_id: TENANT_A });
      await expect(intake.get(authB, c.draft_id, 'r')).rejects.toMatchObject({ statusCode: 404 });
      await expect(promotion.promote(authB, c.draft_id, 'r')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('duplicate queue delivery produces exactly one completed extraction (CAS claim)', async () => {
      orchestratorResult = cannedResult();
      const c = await intake.createIntake(authA, { filename: 'd.pdf', content_type: 'application/pdf' }, 'r');
      await intake.completeUpload(authA, c.draft_id, {}, 'r');
      // The relay publishes once; simulate at-least-once delivery by processing twice.
      await relay.drainOutboxBatch({ limit: 50 });
      const first = await worker.processIntakeDraft({ draft_id: c.draft_id, tenant_id: TENANT_A });
      const second = await worker.processIntakeDraft({ draft_id: c.draft_id, tenant_id: TENANT_A });
      expect(first).toBe(true);
      // Second delivery is a no-op (draft already READY, not QUEUED).
      expect(second).toBe(false);
      const children = await evidencePrisma.resumeExtractionDraft.findMany({
        where: { tenant_id: TENANT_A, source_kind: 'CREATE_DRAFT_UPLOAD', source_ref: c.draft_id },
      });
      expect(children).toHaveLength(1);
    });

    it('SSE notification is tenant-scoped, read-only, PII-free, and reflects committed state', async () => {
      orchestratorResult = cannedResult();
      const c = await intake.createIntake(authA, { filename: 'sse.pdf', content_type: 'application/pdf' }, 'r');
      await intake.completeUpload(authA, c.draft_id, {}, 'r');

      // Before processing: the event reflects the COMMITTED QUEUED state — never
      // ahead of the persisted row.
      const queuedEvent = await intake.buildIntakeEvent(authA, c.draft_id);
      expect(queuedEvent.type).toBe('draft');
      expect((queuedEvent.data as { processing_status: string }).processing_status).toBe('QUEUED');

      // Tenant B cannot subscribe to tenant A's draft events.
      const crossTenant = await intake.buildIntakeEvent(authB, c.draft_id);
      expect(crossTenant.type).toBe('not_found');
      expect(crossTenant.data).toEqual({ id: c.draft_id });

      await relay.drainOutboxBatch({ limit: 50 });
      await worker.processIntakeDraft({ draft_id: c.draft_id, tenant_id: TENANT_A });

      // Event AFTER READY reflects the already-committed state (reads the row).
      const readyEvent = await intake.buildIntakeEvent(authA, c.draft_id);
      expect((readyEvent.data as { processing_status: string }).processing_status).toBe('READY');

      // Small + PII-free: ONLY identifier keys; never prefill/name/email.
      expect(Object.keys(readyEvent.data as object).sort()).toEqual(
        ['id', 'processing_status', 'review_status', 'version'],
      );
      const serialized = JSON.stringify(readyEvent.data);
      expect(serialized).not.toContain('ada@example.com');
      expect(serialized).not.toContain('Ada');

      // Reconnect / duplicate notification is harmless: repeated event builds
      // return identical data and never mutate state (version unchanged).
      const before = await evidenceRepo.findTalentIntakeDraftById({ tenant_id: TENANT_A, id: c.draft_id });
      const e1 = await intake.buildIntakeEvent(authA, c.draft_id);
      const e2 = await intake.buildIntakeEvent(authA, c.draft_id);
      expect(e1.data).toEqual(e2.data);
      const after = await evidenceRepo.findTalentIntakeDraftById({ tenant_id: TENANT_A, id: c.draft_id });
      expect(after?.version).toBe(before?.version);
    });

    // ── Dead-worker activation regressions — through the SCHEDULED entrypoint ──
    // These drive worker.process() with a TICK job (the exact call the registered
    // SCHEDULES entry makes), NOT the drain helpers directly, so they lock the
    // operational wiring: remove the schedule and drafts strand again.
    function tickJob(): Parameters<typeof worker.process>[0] {
      return { name: 'tick', data: {}, id: 'test-tick' } as unknown as Parameters<
        typeof worker.process
      >[0];
    }

    it('scheduled tick drains QUEUED intake drafts (safety-net path)', async () => {
      orchestratorResult = cannedResult();
      const c = await intake.createIntake(authA, { filename: 'tick.pdf', content_type: 'application/pdf' }, 'r');
      await intake.completeUpload(authA, c.draft_id, {}, 'r');
      // Do NOT enqueue via the relay — leave it QUEUED and let the TICK recover it.
      const queued = await evidenceRepo.findTalentIntakeDraftById({ tenant_id: TENANT_A, id: c.draft_id });
      expect(queued?.processing_status).toBe('QUEUED');

      await worker.process(tickJob());

      const drained = await evidenceRepo.findTalentIntakeDraftById({ tenant_id: TENANT_A, id: c.draft_id });
      expect(drained?.processing_status).toBe('READY');
      const child = await evidenceRepo.findResumeExtractionDraftBySource({
        tenant_id: TENANT_A,
        source_kind: 'CREATE_DRAFT_UPLOAD',
        source_ref: c.draft_id,
      });
      expect(child?.status).toBe('READY_FOR_REVIEW');
    });

    it('scheduled tick recovers stranded ATTACHMENT PROCESSING drafts (the dead-worker repair)', async () => {
      orchestratorResult = cannedResult();
      // Seed the EXACT state that stranded before activation: an existing-Talent
      // ATTACHMENT ResumeExtractionDraft left PROCESSING (as the add-resume-edition
      // seam writes it).
      const talentId = uuidv7();
      const attachmentId = uuidv7();
      await evidenceRepo.upsertResumeExtractionDraft({
        id: uuidv7(),
        tenant_id: TENANT_A,
        source_kind: 'ATTACHMENT',
        source_ref: attachmentId,
        talent_id: talentId,
        status: 'PROCESSING',
        created_at: new Date(),
        created_by: ACTOR_A,
      });

      await worker.process(tickJob());

      const recovered = await evidenceRepo.findResumeExtractionDraftBySource({
        tenant_id: TENANT_A,
        source_kind: 'ATTACHMENT',
        source_ref: attachmentId,
      });
      // No longer stranded — the tick drained it to a terminal review state.
      expect(recovered?.status).toBe('READY_FOR_REVIEW');
    });
  },
);
