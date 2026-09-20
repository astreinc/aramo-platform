import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentRecordRepository } from '../lib/talent-record.repository.js';
import { ResumeTextService } from '../lib/resume-text/resume-text.service.js';

// TALENT-INTEL-1 TI-1H — end-to-end proof of edition-aware résumé-text history
// against a real Postgres 17. Exercises the REAL migration chain (drops
// UNIQUE(talent_record_id), adds the per-edition key + partial-unique transient)
// and the REAL ResumeTextService write path + repository readers — NOT mocks.
// Proves the §17 required invariants that only a live DB can:
//   - a newer edition never overwrites an older edition's text (history);
//   - reading edition R returns R's own text;
//   - same-edition retry does not duplicate history;
//   - the edition-aware write adopts the edition-blind transient (no stray row);
//   - search over multiple editions returns the talent ONCE;
//   - tenant A cannot read tenant B's edition text;
//   - legacy/edition-blind rows are never falsely assigned an edition.

const MIGRATIONS_DIR = resolve(__dirname, '../../prisma/migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
  .map((d) => d.name)
  .sort()
  .map((d) => resolve(MIGRATIONS_DIR, d, 'migration.sql'));

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';

// splitDdl (profile-hydration precedent) — comment-safe: strips `--` to EOL then
// splits on statement-terminating `;\n`.
function splitDdl(sql: string): string[] {
  return sql
    .replace(/--[^\n]*$/gm, '')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'résumé-text edition history — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TalentRecordRepository;
    let service: ResumeTextService;
    const talentA = uuidv7();
    const talentB = uuidv7();

    // enqueueReindex is a pure-DB fast path (no S3); the object-storage dep is
    // only touched by drainPendingBatch, which this spec does not exercise.
    const fakeObjectStorage = {
      createPresignedGet: async () => ({ presigned_url: 'https://s3/x', expires_at: 'z' }),
    };
    const fakeLogger = { log: () => undefined, warn: () => undefined, error: () => undefined };

    // Simulate the async re-extract writing redacted text for an edition's row,
    // WITHOUT the S3/extract round-trip (TI-1H is about storage/read identity,
    // not the unchanged deterministic extractor).
    async function setText(tenant: string, talent: string, edition: string, text: string): Promise<void> {
      await prisma.talentResumeText.updateMany({
        where: { tenant_id: tenant, talent_record_id: talent, resume_edition_id: edition },
        data: { redacted_text: text, status: 'extracted', extracted_at: new Date() },
      });
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          await setup.$executeRawUnsafe(stmt);
        }
      }
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new TalentRecordRepository(prisma);
      service = new ResumeTextService(prisma, fakeObjectStorage as never, fakeLogger as never);

      for (const [id, tenant, first] of [
        [talentA, TENANT_A, 'Ada'],
        [talentB, TENANT_B, 'Blaise'],
      ] as const) {
        await prisma.talentRecord.create({
          data: { id, tenant_id: tenant, first_name: first, last_name: 'Doe', email1: `${first}@x.co` },
        });
      }
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('a newer edition never overwrites an older edition’s text (R1/R2/R3 history)', async () => {
      const edR1 = uuidv7();
      const edR2 = uuidv7();
      const edR3 = uuidv7();
      await service.enqueueReindex({ tenant_id: TENANT_A, talent_record_id: talentA, storage_key: 'k/r1', resume_edition_id: edR1 });
      await setText(TENANT_A, talentA, edR1, 'R1 python kubernetes');
      await service.enqueueReindex({ tenant_id: TENANT_A, talent_record_id: talentA, storage_key: 'k/r2', resume_edition_id: edR2 });
      await setText(TENANT_A, talentA, edR2, 'R2 golang terraform');
      await service.enqueueReindex({ tenant_id: TENANT_A, talent_record_id: talentA, storage_key: 'k/r3', resume_edition_id: edR3 });
      await setText(TENANT_A, talentA, edR3, 'R3 rust wasm');

      const r1 = await repo.findResumeEditionText({ tenant_id: TENANT_A, talent_record_id: talentA, resume_edition_id: edR1 });
      const r2 = await repo.findResumeEditionText({ tenant_id: TENANT_A, talent_record_id: talentA, resume_edition_id: edR2 });
      const r3 = await repo.findResumeEditionText({ tenant_id: TENANT_A, talent_record_id: talentA, resume_edition_id: edR3 });
      // Reading R returns R's OWN text — never another edition's.
      expect(r1?.redacted_text).toBe('R1 python kubernetes');
      expect(r2?.redacted_text).toBe('R2 golang terraform');
      expect(r3?.redacted_text).toBe('R3 rust wasm');

      const rows = await prisma.talentResumeText.findMany({ where: { talent_record_id: talentA } });
      expect(rows).toHaveLength(3);
    });

    it('same-edition retry re-pends the SAME row (no duplicate history)', async () => {
      const ed = uuidv7();
      await service.enqueueReindex({ tenant_id: TENANT_A, talent_record_id: talentA, storage_key: 'k/x', resume_edition_id: ed });
      await setText(TENANT_A, talentA, ed, 'first extract');
      await service.enqueueReindex({ tenant_id: TENANT_A, talent_record_id: talentA, storage_key: 'k/x', resume_edition_id: ed });
      const rows = await prisma.talentResumeText.findMany({ where: { talent_record_id: talentA, resume_edition_id: ed } });
      expect(rows).toHaveLength(1);
      // The retry re-pends the same row for re-extraction (text kept until replaced).
      expect(rows[0]?.status).toBe('pending');
    });

    it('the edition-aware write ADOPTS a prior edition-blind transient (one row, not two)', async () => {
      const att = uuidv7();
      const ed = uuidv7();
      // 1. attachment-commit (edition-blind) — a transient row for the attachment.
      await service.enqueueReindex({ tenant_id: TENANT_A, talent_record_id: talentB, attachment_id: att, storage_key: 'k/ad' });
      // 2. edition minted from the same attachment (TalentEditView commit→edition).
      await service.enqueueReindex({ tenant_id: TENANT_A, talent_record_id: talentB, attachment_id: att, storage_key: 'k/ad', resume_edition_id: ed });

      const rows = await prisma.talentResumeText.findMany({ where: { talent_record_id: talentB, attachment_id: att } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.resume_edition_id).toBe(ed); // the transient was adopted
    });

    it('the edition-blind transient is deduped per attachment (retry does not multiply)', async () => {
      const att = uuidv7();
      await service.enqueueReindex({ tenant_id: TENANT_A, talent_record_id: talentB, attachment_id: att, storage_key: 'k/t1' });
      await service.enqueueReindex({ tenant_id: TENANT_A, talent_record_id: talentB, attachment_id: att, storage_key: 'k/t2' });
      const rows = await prisma.talentResumeText.findMany({ where: { talent_record_id: talentB, attachment_id: att, resume_edition_id: null } });
      expect(rows).toHaveLength(1);
    });

    it('search over multiple editions returns the talent ONCE (§8 match-any, dedup)', async () => {
      const talent = uuidv7();
      await prisma.talentRecord.create({ data: { id: talent, tenant_id: TENANT_A, first_name: 'Grace', last_name: 'Hopper', email1: 'grace@x.co' } });
      const e1 = uuidv7();
      const e2 = uuidv7();
      await service.enqueueReindex({ tenant_id: TENANT_A, talent_record_id: talent, storage_key: 'k/e1', resume_edition_id: e1 });
      await setText(TENANT_A, talent, e1, 'distinctivetoken alpha compiler');
      await service.enqueueReindex({ tenant_id: TENANT_A, talent_record_id: talent, storage_key: 'k/e2', resume_edition_id: e2 });
      await setText(TENANT_A, talent, e2, 'distinctivetoken beta compiler');

      const results = await repo.searchByResumeText({ tenant_id: TENANT_A, resume_q: 'distinctivetoken' });
      const matches = results.filter((r) => r.id === talent);
      expect(matches).toHaveLength(1); // matched on both editions, returned once
    });

    it('tenant A cannot read tenant B’s edition text', async () => {
      const ed = uuidv7();
      await service.enqueueReindex({ tenant_id: TENANT_B, talent_record_id: talentB, storage_key: 'k/b', resume_edition_id: ed });
      await setText(TENANT_B, talentB, ed, 'tenant B private résumé');
      // Correct tenant sees it; the other tenant does not.
      const own = await repo.findResumeEditionText({ tenant_id: TENANT_B, talent_record_id: talentB, resume_edition_id: ed });
      const cross = await repo.findResumeEditionText({ tenant_id: TENANT_A, talent_record_id: talentB, resume_edition_id: ed });
      expect(own?.redacted_text).toBe('tenant B private résumé');
      expect(cross).toBeNull();
    });

    it('a legacy edition-blind row is never falsely assigned an edition', async () => {
      const talent = uuidv7();
      await prisma.talentRecord.create({ data: { id: talent, tenant_id: TENANT_A, first_name: 'Alan', last_name: 'Turing', email1: 'alan@x.co' } });
      const att = uuidv7();
      // A committed résumé attachment that never becomes an edition (TalentEditDrawer).
      await service.enqueueReindex({ tenant_id: TENANT_A, talent_record_id: talent, attachment_id: att, storage_key: 'k/legacy' });
      const rows = await prisma.talentResumeText.findMany({ where: { talent_record_id: talent } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.resume_edition_id).toBeNull(); // stays unmapped — no invented identity
    });

    it('the per-edition unique rejects a second row for the same edition', async () => {
      const ed = uuidv7();
      await prisma.talentResumeText.create({
        data: { tenant_id: TENANT_A, talent_record_id: talentA, resume_edition_id: ed, status: 'extracted', redacted_text: 'one' },
      });
      await expect(
        prisma.talentResumeText.create({
          data: { tenant_id: TENANT_A, talent_record_id: talentA, resume_edition_id: ed, status: 'extracted', redacted_text: 'two' },
        }),
      ).rejects.toThrow();
    });
  },
);
