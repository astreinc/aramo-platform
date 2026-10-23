import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

import type { DraftFromResumeResponse } from '../lib/dto/draft-from-resume.response.js';
import { TalentIntakeExtractionService } from '../lib/talent-intake/talent-intake-extraction.service.js';
import { TalentIntakePromotionService } from '../lib/talent-intake/talent-intake-promotion.service.js';
import { TalentIntakeService } from '../lib/talent-intake/talent-intake.service.js';
import {
  TALENT_INTAKE_EXTRACTION_REQUESTED_EVENT,
  TALENT_INTAKE_SOURCE_TYPE_RESUME_UPLOAD,
} from '../lib/talent-intake/talent-intake.constants.js';

// ATS-QA-1 I-3 — draft integrity (Durable-Async I7 / §8.5 conformance) against a
// REAL Postgres 17: the real TalentEvidenceRepository + TalentExtractionService
// + the intake services; only the governed extraction call (orchestrator) and
// the Talent create composition are stubbed. Proves: concurrent extraction vs
// edit, a recruiter save landing between the worker's read and write (CAS
// retry), partial extraction, stale draft (409), save → reopen, failed
// extraction, repeated extraction, and that work history + education never
// disappear — through to the promote input.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATION_LIBS = ['documents', 'talent-evidence'];

function collectMigrations(): string[] {
  const all: { name: string; path: string }[] = [];
  for (const lib of MIGRATION_LIBS) {
    const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && /^\d+_/.test(d.name)) {
        all.push({ name: d.name, path: resolve(dir, d.name, 'migration.sql') });
      }
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name)).map((m) => m.path);
}

// Dollar-quote / comment / string-literal aware splitter (documents carries
// `$$`-quoted trigger bodies). Only splits on a top-level `;`.
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
        if (dollarTag === null || dollarTag === tag) {
          dollarTag = dollarTag === null ? tag : null;
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
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const last = current.trim();
  if (last.length > 0) statements.push(last);
  return statements;
}

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '33333333-3333-7333-8333-333333333333';
const auth = { tenant_id: TENANT, sub: ACTOR } as never;
const noopLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const WH_EXTRACTED = [
  { employer_name: 'Initech', role_title: 'Analyst', start_date: '2016', end_date: '2019', source_refs: ['B003'] },
  { employer_name: 'Globex', role_title: 'Engineer', start_date: '2019', end_date: 'Present', source_refs: ['B005'] },
];
const ED_EXTRACTED = [{ institution_name: 'State University', degree_name: 'BSc', source_refs: ['B009'] }];

function ready(over: Partial<DraftFromResumeResponse> = {}): DraftFromResumeResponse {
  return {
    prefill: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      email1: 'ada@example.com',
      phone_cell: '+15551230000',
      title: 'Analyst',
      key_skills: 'SQL, Python',
    },
    parse_status: 'parsed',
    extraction_status: 'success',
    work_history: WH_EXTRACTED,
    education: ED_EXTRACTED,
    skills: [{ surface_form: 'SQL', source_refs: ['B004'] }],
    source_map_version: 'resume-source-map/v1',
    resume_text_hash: 'hash-1',
    ...over,
  } as DraftFromResumeResponse;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ATS-QA-1 I-3 — talent-intake draft integrity (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: EvidencePrismaService;
    let extraction: TalentExtractionService;
    let intake: TalentIntakeService;
    let worker: TalentIntakeExtractionService;
    let promotion: TalentIntakePromotionService;
    let extractResume: ReturnType<typeof vi.fn>;
    let confirmCreate: ReturnType<typeof vi.fn>;

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
      prisma = new EvidencePrismaService(url);
      await prisma.$connect();
      const repo = new TalentEvidenceRepository(prisma);
      extraction = new TalentExtractionService(
        { generateDraft: vi.fn() } as never,
        repo,
        { generateStructured: vi.fn() } as never,
      );
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    beforeEach(async () => {
      await prisma.talentIntakeOutboxEvent.deleteMany({ where: { tenant_id: TENANT } });
      await prisma.talentIntakeDraft.deleteMany({ where: { tenant_id: TENANT } });
      extractResume = vi.fn();
      confirmCreate = vi.fn(async () => ({ id: uuidv7(), first_name: 'Ada', last_name: 'Lovelace' }));
      intake = new TalentIntakeService(
        {} as never,
        extraction,
        { findDuplicateByEmail: async () => null } as never,
      );
      worker = new TalentIntakeExtractionService(
        { extractResume } as never,
        extraction,
        noopLogger as never,
      );
      promotion = new TalentIntakePromotionService(
        extraction,
        { confirmCreateFromDraftUpload: confirmCreate, createFromReviewedUpload: vi.fn() } as never,
        { findById: async () => null, findActiveByEmail: async () => null } as never,
      );
    });

    // UPLOADED → QUEUED (the complete-upload outbox path), returns the id.
    async function queuedDraft(): Promise<string> {
      const id = uuidv7();
      await extraction.createTalentIntakeDraft({
        id,
        tenant_id: TENANT,
        created_by: ACTOR,
        source_type: TALENT_INTAKE_SOURCE_TYPE_RESUME_UPLOAD,
        source_filename: 'ada.pdf',
        storage_key: `${TENANT}/resumes/${id}/ada.pdf`,
        mime_type: 'application/pdf',
      });
      await requeueUpload(id);
      return id;
    }
    async function requeueUpload(id: string): Promise<void> {
      await extraction.completeTalentIntakeUploadWithOutbox({
        tenant_id: TENANT,
        id,
        created_by: ACTOR,
        mime_type: 'application/pdf',
        size_bytes: 1024,
        event_type: TALENT_INTAKE_EXTRACTION_REQUESTED_EVENT,
        event_payload: { draft_id: id },
      });
    }
    // A repeated extraction on the same draft: re-point the artifact (UPLOADED)
    // then complete-upload again (QUEUED) — the replace-résumé path.
    async function reExtract(id: string, result: DraftFromResumeResponse | Error): Promise<void> {
      await extraction.replaceTalentIntakeDraftArtifact({
        tenant_id: TENANT,
        id,
        created_by: ACTOR,
        storage_key: `${TENANT}/resumes/${id}/ada-v2.pdf`,
        source_filename: 'ada-v2.pdf',
        mime_type: 'application/pdf',
      });
      await requeueUpload(id);
      await run(id, result);
    }
    async function run(id: string, result: DraftFromResumeResponse | Error): Promise<boolean> {
      extractResume.mockImplementationOnce(async () => {
        if (result instanceof Error) throw result;
        return result;
      });
      return worker.processIntakeDraft({ draft_id: id, tenant_id: TENANT });
    }
    const view = (id: string) => intake.get(auth, id, 'req');
    type Review = {
      fields: Record<string, { value: unknown; origin: string }>;
      work_history?: unknown[];
      education?: unknown[];
      skills?: unknown[];
      array_origin?: Record<string, string>;
    };
    const review = async (id: string): Promise<Review> => (await view(id)).review_payload as Review;
    const patch = async (id: string, body: unknown, expected?: number) =>
      intake.patchReview(
        auth,
        id,
        { review: body, expected_version: expected ?? (await view(id)).version },
        'req',
      );

    it('concurrent extraction vs edit: a recruiter save made WHILE extraction runs survives; extraction fills the rest', async () => {
      const id = await queuedDraft();
      extractResume.mockImplementationOnce(async () => {
        // The recruiter edits while the worker is extracting (status PROCESSING).
        await patch(id, {
          fields: { title: { value: 'Lead Analyst', origin: 'RECRUITER' } },
          work_history: [{ employer_name: 'Initech', role_title: 'Senior Analyst' }],
        });
        return ready();
      });
      expect(await worker.processIntakeDraft({ draft_id: id, tenant_id: TENANT })).toBe(true);

      const v = await view(id);
      expect(v.processing_status).toBe('READY');
      const r = v.review_payload as Review;
      expect(r.fields['title']).toEqual({ value: 'Lead Analyst', origin: 'RECRUITER' });
      expect(r.fields['first_name']).toEqual({ value: 'Ada', origin: 'RESUME_EXTRACTION' });
      expect(r.work_history).toEqual([{ employer_name: 'Initech', role_title: 'Senior Analyst' }]);
      expect(r.array_origin?.['work_history']).toBe('RECRUITER');
      expect(r.education).toEqual(ED_EXTRACTED);
      expect(r.array_origin?.['education']).toBe('RESUME_EXTRACTION');
    });

    it('a recruiter save landing between the worker read and its write is kept (CAS retry)', async () => {
      const id = await queuedDraft();
      const original = extraction.saveTalentIntakeDraftReview.bind(extraction);
      let injected = false;
      const spy = vi
        .spyOn(extraction, 'saveTalentIntakeDraftReview')
        .mockImplementation(async (input) => {
          // The worker's write carries no created_by; inject one recruiter save
          // right before its FIRST write so that write is stale.
          if (input.created_by === undefined && !injected) {
            injected = true;
            const current = await extraction.findTalentIntakeDraftById({ tenant_id: TENANT, id });
            await original({
              tenant_id: TENANT,
              id,
              created_by: ACTOR,
              expected_version: current?.version ?? 0,
              review_payload: {
                fields: { notes: { value: 'Prefers remote', origin: 'RECRUITER' } },
              },
              review_status: 'IN_REVIEW',
            });
          }
          return original(input);
        });
      await run(id, ready());
      const workerWrites = spy.mock.calls.filter((c) => c[0].created_by === undefined);
      spy.mockRestore();

      expect(workerWrites.length).toBe(2); // first stale (0 rows), second wins
      const r = await review(id);
      expect(r.fields['notes']).toEqual({ value: 'Prefers remote', origin: 'RECRUITER' });
      expect(r.fields['first_name']?.value).toBe('Ada');
      expect(r.work_history).toEqual(WH_EXTRACTED);
      expect(r.education).toEqual(ED_EXTRACTED);
    });

    it('partial extraction then retry with fewer facts: work history + education never disappear', async () => {
      const id = await queuedDraft();
      await run(id, ready({ parse_status: 'partial', extraction_status: 'partial' }));
      expect((await view(id)).processing_status).toBe('PARTIAL');

      await intake.retry(auth, id, 'req'); // PARTIAL → QUEUED (same artifact)
      await run(
        id,
        ready({
          prefill: { first_name: 'Ada' },
          parse_status: 'partial',
          extraction_status: 'partial',
          work_history: undefined,
          education: undefined,
          skills: undefined,
        }),
      );
      const r = await review(id);
      expect(r.work_history).toEqual(WH_EXTRACTED);
      expect(r.education).toEqual(ED_EXTRACTED);
      expect(r.skills).toEqual([{ surface_form: 'SQL', source_refs: ['B004'] }]);
      expect(r.fields['email1']?.value).toBe('ada@example.com');
    });

    it('stale draft: a save on an old version is refused (409) and changes nothing', async () => {
      const id = await queuedDraft();
      await run(id, ready());
      const before = await view(id);
      await expect(
        patch(id, { fields: { title: { value: 'X', origin: 'RECRUITER' } }, work_history: [] }, before.version - 1),
      ).rejects.toMatchObject({ statusCode: 409 });
      const after = await view(id);
      expect(after.version).toBe(before.version);
      expect((after.review_payload as Review).work_history).toEqual(WH_EXTRACTED);
      expect((after.review_payload as Review).fields['title']?.value).toBe('Analyst');
    });

    it('save → reopen: a scalar-only save keeps the extracted arrays; an array save is recruiter-owned on reopen', async () => {
      const id = await queuedDraft();
      await run(id, ready());
      await patch(id, { fields: { notes: { value: 'Call Tuesday', origin: 'RECRUITER' } } });
      let r = await review(id); // reopen from another session = authoritative GET
      expect(r.work_history).toEqual(WH_EXTRACTED);
      expect(r.education).toEqual(ED_EXTRACTED);
      expect(r.array_origin).toEqual({ work_history: 'RESUME_EXTRACTION', education: 'RESUME_EXTRACTION' });
      expect(r.fields['notes']).toEqual({ value: 'Call Tuesday', origin: 'RECRUITER' });

      await patch(id, { fields: {}, work_history: [WH_EXTRACTED[1]] });
      r = await review(id);
      expect(r.work_history).toEqual([WH_EXTRACTED[1]]);
      expect(r.array_origin?.['work_history']).toBe('RECRUITER');
      expect(r.education).toEqual(ED_EXTRACTED);
      expect(r.fields['notes']?.value).toBe('Call Tuesday');
    });

    it('failed extraction after a good one leaves the review untouched (nothing disappears)', async () => {
      const id = await queuedDraft();
      await run(id, ready());
      const before = await review(id);
      await reExtract(id, ready({ prefill: {}, parse_status: 'failed', extraction_status: 'provider_failure', work_history: undefined, education: undefined }));
      expect((await view(id)).processing_status).toBe('FAILED');
      expect(await review(id)).toEqual(before);

      // A thrown extraction (technical failure) also leaves it untouched.
      await intake.retry(auth, id, 'req');
      await run(id, new Error('provider exploded'));
      expect((await view(id)).processing_status).toBe('FAILED');
      expect(await review(id)).toEqual(before);
    });

    it('repeated extraction: the recruiter-edited array and fields are kept, untouched ones refresh', async () => {
      const id = await queuedDraft();
      await run(id, ready());
      await patch(id, {
        fields: { first_name: { value: 'Augusta', origin: 'RECRUITER' } },
        work_history: [{ employer_name: 'Initech', role_title: 'Senior Analyst' }],
      });
      const ED_V2 = [{ institution_name: 'Tech Institute', degree_name: 'MSc', source_refs: ['B011'] }];
      await reExtract(
        id,
        ready({
          prefill: { first_name: 'A.', last_name: 'King', email1: 'ada@example.com', phone_cell: '+15551230000' },
          work_history: [{ employer_name: 'Umbrella', role_title: 'Director', source_refs: ['B002'] }],
          education: ED_V2,
          resume_text_hash: 'hash-2',
        }),
      );
      const r = await review(id);
      expect(r.fields['first_name']).toEqual({ value: 'Augusta', origin: 'RECRUITER' });
      expect(r.fields['last_name']).toEqual({ value: 'King', origin: 'RESUME_EXTRACTION' });
      expect(r.work_history).toEqual([{ employer_name: 'Initech', role_title: 'Senior Analyst' }]);
      expect(r.education).toEqual(ED_V2);
    });

    it('promote after a save carries the extracted work history and education into the create input', async () => {
      const id = await queuedDraft();
      await run(id, ready());
      await patch(id, { fields: { title: { value: 'Lead Analyst', origin: 'RECRUITER' } } });
      await promotion.promote(auth, id, 'req');
      expect(confirmCreate).toHaveBeenCalledTimes(1);
      const body = confirmCreate.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(body['work_history']).toEqual(WH_EXTRACTED);
      expect(body['education']).toEqual(ED_EXTRACTED);
      expect(body['title']).toBe('Lead Analyst');
      expect((await view(id)).review_status).toBe('PROMOTED');

      // A late extraction after promotion never rewrites the promoted draft.
      const before = await review(id);
      await prisma.talentIntakeDraft.update({ where: { id }, data: { processing_status: 'QUEUED' } });
      await run(id, ready({ work_history: [] }));
      expect(await review(id)).toEqual(before);
    });
  },
);
