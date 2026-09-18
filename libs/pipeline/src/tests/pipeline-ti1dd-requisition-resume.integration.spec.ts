import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PipelineRepository } from '../lib/pipeline.repository.js';

// TALENT-INTEL-1 TI-1D-D (Layer A) — the lib-local acceptance proofs for the
// TalentRequisitionResume APPEND-ONLY working-selection substrate: current
// selection = latest selected_at; UPDATE rejected wholesale; DELETE rejected
// except a governed tenant-reset. The table only participates in the `pipeline`
// schema (UUID-only cross-schema refs, no FK), so a minimal migration set (the
// pipeline init + this slice's migration) suffices.
const MIGRATIONS = [
  '../../prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  '../../prisma/migrations/20260920120000_talent_intel_1d_d_requisition_resume/migration.sql',
].map((p) => resolve(__dirname, p));

// Dollar-quote- AND line-comment-aware splitter (the TI-1D-D migration carries
// `$$` trigger bodies + `--` prose authored `;`-free per the splitter guard).
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      cur += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      cur += ch;
      continue;
    }
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      cur += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '55555555-5555-7555-8555-555555555555';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TI-1D-D TalentRequisitionResume append-only substrate (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setup: PrismaService;
    let prisma: PrismaService;
    let repo: PipelineRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setup = new PrismaService(url);
      await setup.$connect();
      for (const m of MIGRATIONS) {
        for (const s of splitDdl(readFileSync(m, 'utf8'))) {
          if (s.trim()) await setup.$executeRawUnsafe(s.trim());
        }
      }
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new PipelineRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await setup?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('current selection = the LATEST selected_at (not the first) — history coexists', async () => {
      const talent = randomUUID();
      const req = randomUUID();
      const edOld = randomUUID();
      const edNew = randomUUID();
      // Two selections for the SAME triple, older then newer.
      await prisma.talentRequisitionResume.create({
        data: { id: randomUUID(), tenant_id: TENANT, talent_record_id: talent, requisition_id: req, resume_edition_id: edOld, selected_by: ACTOR, selected_at: new Date('2026-07-01T00:00:00.000Z') },
      });
      await prisma.talentRequisitionResume.create({
        data: { id: randomUUID(), tenant_id: TENANT, talent_record_id: talent, requisition_id: req, resume_edition_id: edNew, selected_by: ACTOR, selected_at: new Date('2026-07-05T00:00:00.000Z') },
      });
      const cur = await repo.getCurrentRequisitionResume({ tenant_id: TENANT, talent_record_id: talent, requisition_id: req });
      expect(cur?.resume_edition_id).toBe(edNew); // latest wins for CURRENT, both rows persist
      const all = await prisma.talentRequisitionResume.count({ where: { tenant_id: TENANT, talent_record_id: talent, requisition_id: req } });
      expect(all).toBe(2); // append-only: the earlier row is NOT overwritten
    });

    it('repo append creates a new row; UPDATE is rejected (append-only)', async () => {
      const talent = randomUUID();
      const req = randomUUID();
      const row = await repo.createRequisitionResumeSelection({
        tenant_id: TENANT, talent_record_id: talent, requisition_id: req, resume_edition_id: randomUUID(), selected_by: ACTOR, note: 'first',
      });
      expect(row.id).toBeTruthy();
      await expect(
        prisma.talentRequisitionResume.update({ where: { id: row.id }, data: { note: 'mutated' } }),
      ).rejects.toThrow(/append-only/);
    });

    it('DELETE is rejected without the governed tenant-reset', async () => {
      const talent = randomUUID();
      const req = randomUUID();
      const row = await repo.createRequisitionResumeSelection({
        tenant_id: TENANT, talent_record_id: talent, requisition_id: req, resume_edition_id: randomUUID(), selected_by: ACTOR,
      });
      await expect(
        prisma.$executeRawUnsafe(`DELETE FROM "pipeline"."TalentRequisitionResume" WHERE id = '${row.id}'`),
      ).rejects.toThrow(/append-only/);
    });
  },
);
