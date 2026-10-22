import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { Client } from 'pg';
import { PipelineController, PipelinePrismaService, PipelineRepository } from '@aramo/pipeline';
import {
  PrismaService as TalentEvidencePrismaService,
  TalentEvidenceRepository,
} from '@aramo/talent-evidence';

import { ResumeEditionReaderAdapter } from '../resume-extraction/resume-edition-reader.module.js';

// ATS-QA-1 I-5 (amendment A4) — real-PG proofs for the requisition résumé selection
// write (PUT /v1/pipelines/:id/resume-edition) that the add-time résumé picker uses.
// The REAL PipelineController + PipelineRepository + the REAL composition-root
// ResumeEditionReaderAdapter over talent-evidence + documents, on one Postgres 17:
//   - selection lands on the pipeline's own (tenant, talent, requisition) only;
//   - another Talent's edition, a cross-tenant edition, an archived / retracted
//     edition and a hidden requisition are refused and write nothing;
//   - concurrent selections are deterministic (append-only; the current one is the
//     latest selected_at, ties broken by id — every reader agrees).
// The scope gate (pipeline:resume:set) is pinned against the real handler metadata
// in libs/pipeline/src/tests/pipeline-resume-edition-routes.spec.ts.

const ROOT = resolve(__dirname, '../../../..');
function migrationFiles(libDir: string): string[] {
  const dir = resolve(ROOT, libDir, 'prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const ACTOR = randomUUID();

function auth(tenant = TENANT): AuthContextType {
  return { sub: ACTOR, tenant_id: tenant, scopes: ['pipeline:read', 'pipeline:resume:set'] } as unknown as AuthContextType;
}
function visible(ids: string[]): never {
  return { resolveVisibleRequisitionIds: async () => ids } as never;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ATS-QA-1 I-5 — requisition résumé selection server checks (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let pipelinePrisma: PipelinePrismaService;
    let evidencePrisma: TalentEvidencePrismaService;
    let evidence: TalentEvidenceRepository;
    let pipelines: PipelineRepository;
    let ctl: PipelineController;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new Client({ connectionString: url });
      await setup.connect();
      // Whole-file apply (pg multi-statement is dollar-quote + comment safe).
      for (const lib of ['libs/documents', 'libs/talent-evidence', 'libs/pipeline']) {
        for (const p of migrationFiles(lib)) await setup.query(readFileSync(p, 'utf8'));
      }
      await setup.end();
      pipelinePrisma = new PipelinePrismaService(url);
      await pipelinePrisma.$connect();
      evidencePrisma = new TalentEvidencePrismaService(url);
      await evidencePrisma.$connect();
      evidence = new TalentEvidenceRepository(evidencePrisma);
      pipelines = new PipelineRepository(pipelinePrisma);
      ctl = new PipelineController(
        pipelines,
        {} as never,
        {} as never,
        new ResumeEditionReaderAdapter(evidence),
      );
    }, 180_000);

    afterAll(async () => {
      await pipelinePrisma?.$disconnect();
      await evidencePrisma?.$disconnect();
      await container?.stop();
    });

    async function seedEdition(
      tenant: string,
      talent: string,
      lifecycle: 'active' | 'archived' | 'retracted' = 'active',
    ): Promise<string> {
      const doc = randomUUID();
      const ed = randomUUID();
      await evidence.createTalentDocument({
        id: doc, talent_id: talent, tenant_id: tenant, uploaded_by_actor_id: ACTOR,
        uploaded_at: new Date('2026-10-01T00:00:00.000Z'), document_type: 'resume',
        filename: `${ed}.pdf`, file_storage_ref: `k/${ed}`, mime_type: 'application/pdf',
        size_bytes: 1000, parse_status: 'parsed', consent_scope_at_upload: [],
        retention_policy: 'default', is_active: true,
      });
      await evidence.createTalentResumeEdition({
        id: ed, tenant_id: tenant, talent_id: talent, talent_document_id: doc,
        content_hash: `h-${ed}`, purpose: 'GENERAL', lifecycle_status: lifecycle,
        created_at: new Date('2026-10-01T00:00:00.000Z'), created_by: ACTOR,
      });
      return ed;
    }

    async function seedPipeline(tenant: string, talent: string, requisition: string): Promise<string> {
      const row = await pipelinePrisma.pipeline.create({
        data: { tenant_id: tenant, talent_record_id: talent, requisition_id: requisition },
      });
      return row.id;
    }

    async function selectionCount(talent: string, requisition: string): Promise<number> {
      return pipelinePrisma.talentRequisitionResume.count({
        where: { tenant_id: TENANT, talent_record_id: talent, requisition_id: requisition },
      });
    }

    it('selects an active edition of this Talent for THIS requisition only (another requisition’s selection unchanged)', async () => {
      const talent = randomUUID();
      const reqA = randomUUID();
      const reqB = randomUUID();
      const ed1 = await seedEdition(TENANT, talent);
      const ed2 = await seedEdition(TENANT, talent);
      const plA = await seedPipeline(TENANT, talent, reqA);
      const plB = await seedPipeline(TENANT, talent, reqB);
      await ctl.setResumeEdition(auth(), plB, { resume_edition_id: ed1 }, 'rq', visible([reqA, reqB]));
      const view = await ctl.setResumeEdition(auth(), plA, { resume_edition_id: ed2 }, 'rq', visible([reqA, reqB]));
      expect(view.selected_edition_id).toBe(ed2);
      expect(view.requisition_id).toBe(reqA);
      const other = await pipelines.getCurrentRequisitionResume({ tenant_id: TENANT, talent_record_id: talent, requisition_id: reqB });
      expect(other?.resume_edition_id).toBe(ed1);
    });

    it('another Talent’s edition (same tenant) → 404, nothing written', async () => {
      const talent = randomUUID();
      const req = randomUUID();
      await seedEdition(TENANT, talent);
      const foreign = await seedEdition(TENANT, randomUUID());
      const pl = await seedPipeline(TENANT, talent, req);
      await expect(
        ctl.setResumeEdition(auth(), pl, { resume_edition_id: foreign }, 'rq', visible([req])),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
      expect(await selectionCount(talent, req)).toBe(0);
    });

    it('cross-tenant edition (same Talent id, other tenant) → 404, nothing written', async () => {
      const talent = randomUUID();
      const req = randomUUID();
      const crossTenant = await seedEdition(OTHER_TENANT, talent);
      const pl = await seedPipeline(TENANT, talent, req);
      await expect(
        ctl.setResumeEdition(auth(), pl, { resume_edition_id: crossTenant }, 'rq', visible([req])),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
      expect(await selectionCount(talent, req)).toBe(0);
    });

    it('a caller in another tenant cannot reach the pipeline at all → 404, nothing written', async () => {
      const talent = randomUUID();
      const req = randomUUID();
      const ed = await seedEdition(TENANT, talent);
      const pl = await seedPipeline(TENANT, talent, req);
      await expect(
        ctl.setResumeEdition(auth(OTHER_TENANT), pl, { resume_edition_id: ed }, 'rq', visible([req])),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
      expect(await selectionCount(talent, req)).toBe(0);
    });

    it.each(['archived', 'retracted'] as const)('%s edition → 422, nothing written', async (lifecycle) => {
      const talent = randomUUID();
      const req = randomUUID();
      const retired = await seedEdition(TENANT, talent, lifecycle);
      const pl = await seedPipeline(TENANT, talent, req);
      await expect(
        ctl.setResumeEdition(auth(), pl, { resume_edition_id: retired }, 'rq', visible([req])),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422 });
      expect(await selectionCount(talent, req)).toBe(0);
    });

    it('hidden requisition (not in the caller’s visible set) → 404, nothing written', async () => {
      const talent = randomUUID();
      const req = randomUUID();
      const ed = await seedEdition(TENANT, talent);
      const pl = await seedPipeline(TENANT, talent, req);
      await expect(
        ctl.setResumeEdition(auth(), pl, { resume_edition_id: ed }, 'rq', visible([randomUUID()])),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
      expect(await selectionCount(talent, req)).toBe(0);
    });

    it('concurrent selections are deterministic: both rows kept, every reader names the same current one', async () => {
      const talent = randomUUID();
      const req = randomUUID();
      const ed1 = await seedEdition(TENANT, talent);
      const ed2 = await seedEdition(TENANT, talent);
      const pl = await seedPipeline(TENANT, talent, req);
      await Promise.all([
        ctl.setResumeEdition(auth(), pl, { resume_edition_id: ed1 }, 'rq', visible([req])),
        ctl.setResumeEdition(auth(), pl, { resume_edition_id: ed2 }, 'rq', visible([req])),
      ]);
      expect(await selectionCount(talent, req)).toBe(2); // append-only, no lost write
      const rows = await pipelinePrisma.talentRequisitionResume.findMany({
        where: { tenant_id: TENANT, talent_record_id: talent, requisition_id: req },
      });
      const expected = [...rows].sort((a, b) =>
        b.selected_at.getTime() - a.selected_at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )[0].resume_edition_id;
      const viaRead = await ctl.getResumeEdition(auth(), pl, 'rq', visible([req]));
      const viaBatch = await pipelines.listCurrentRequisitionResumes({ tenant_id: TENANT, requisition_id: req, talent_record_ids: [talent] });
      expect(viaRead.selected_edition_id).toBe(expected);
      expect(viaBatch.get(talent)?.resume_edition_id).toBe(expected);
    });

    it('a selected_at tie resolves by id DESC in every reader (Prisma + the raw-SQL submit/workspace order)', async () => {
      const talent = randomUUID();
      const req = randomUUID();
      const at = new Date('2026-10-22T10:00:00.000Z');
      const lowId = '00000000-0000-4000-8000-000000000001';
      const highId = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
      const edLow = randomUUID();
      const edHigh = randomUUID();
      // Insert the higher id FIRST so insertion order cannot explain the result.
      await pipelinePrisma.talentRequisitionResume.create({
        data: { id: highId, tenant_id: TENANT, talent_record_id: talent, requisition_id: req, resume_edition_id: edHigh, selected_by: ACTOR, selected_at: at },
      });
      await pipelinePrisma.talentRequisitionResume.create({
        data: { id: lowId, tenant_id: TENANT, talent_record_id: talent, requisition_id: req, resume_edition_id: edLow, selected_by: ACTOR, selected_at: at },
      });
      const cur = await pipelines.getCurrentRequisitionResume({ tenant_id: TENANT, talent_record_id: talent, requisition_id: req });
      expect(cur?.resume_edition_id).toBe(edHigh);
      const batch = await pipelines.listCurrentRequisitionResumes({ tenant_id: TENANT, requisition_id: req, talent_record_ids: [talent] });
      expect(batch.get(talent)?.resume_edition_id).toBe(edHigh);
      // The same ORDER BY the submit-talent freeze and submittal-workspace readers use.
      const raw = await pipelinePrisma.$queryRawUnsafe<Array<{ resume_edition_id: string }>>(
        `SELECT "resume_edition_id" FROM "pipeline"."TalentRequisitionResume"
          WHERE "tenant_id" = $1::uuid AND "talent_record_id" = $2::uuid AND "requisition_id" = $3::uuid
          ORDER BY "selected_at" DESC, "id" DESC LIMIT 1`,
        TENANT,
        talent,
        req,
      );
      expect(raw[0]?.resume_edition_id).toBe(edHigh);
    });
  },
);
