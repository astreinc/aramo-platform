import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentRecordReconcileRepository } from '../lib/talent-record-reconcile.repository.js';

// Promotion Gate Slice-B1 — integration proof for the reconcile writes against a
// real Postgres 17: the hand-authored projection-tables migration APPLIES, the
// fill-null enrichment updates the flat row, and the two annotation tables
// upsert/dedup idempotently. init (TalentRecord) + the reconcile migration are
// the only DDL these repo methods need.

// Apply every talent-record migration in chronological order (timestamped
// prefixes → lexical sort = chronological) so the regenerated client's SELECT *
// finds every column it projects (availability_status, work_authorization, …),
// ending with the Slice-B1 reconcile-projection tables.
const MIGRATIONS_DIR = resolve(__dirname, '../../prisma/migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
  .map((d) => d.name)
  .sort()
  .map((d) => resolve(MIGRATIONS_DIR, d, 'migration.sql'));

const TENANT = '11111111-1111-7111-8111-111111111111';

// Strip line comments, then split on statement-boundary semicolons (the
// migrations carry no $$ bodies).
function splitDdl(sql: string): string[] {
  return sql
    .replace(/--[^\n]*$/gm, '')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TalentRecordReconcileRepository — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TalentRecordReconcileRepository;

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
      repo = new TalentRecordReconcileRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function seedRecord(): Promise<string> {
      const id = uuidv7();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "talent_record"."TalentRecord" (id, tenant_id, first_name, last_name)
         VALUES ('${id}'::uuid, '${TENANT}'::uuid, 'Alan', 'Turing')`,
      );
      return id;
    }

    it('applyEnrichment fills only the provided (null) slots on the flat row', async () => {
      const recordId = await seedRecord();
      await repo.applyEnrichment({
        tenant_id: TENANT,
        talent_record_id: recordId,
        patch: { email1: 'alan@x.com', phone_cell: '+15550001' },
      });
      const row = await prisma.talentRecord.findUnique({ where: { id: recordId } });
      expect(row?.email1).toBe('alan@x.com');
      expect(row?.phone_cell).toBe('+15550001');
      // untouched
      expect(row?.web_site).toBeNull();

      // Empty patch → no-op (no throw).
      await expect(
        repo.applyEnrichment({ tenant_id: TENANT, talent_record_id: recordId, patch: {} }),
      ).resolves.toBeUndefined();
    });

    it('upsertFieldProvenance is one-row-per-(record,field), re-pointing on re-projection', async () => {
      const recordId = await seedRecord();
      const ev1 = uuidv7();
      const ev2 = uuidv7();
      await repo.upsertFieldProvenance({ tenant_id: TENANT, talent_record_id: recordId, field_name: 'email1', evidence_id: ev1 });
      await repo.upsertFieldProvenance({ tenant_id: TENANT, talent_record_id: recordId, field_name: 'email1', evidence_id: ev2 });

      const rows = await repo.listFieldProvenance(recordId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ field_name: 'email1', evidence_id: ev2 });
    });

    it('recordPendingContradiction is idempotent on (record, field, evidence)', async () => {
      const recordId = await seedRecord();
      const ev = uuidv7();
      await repo.recordPendingContradiction({ tenant_id: TENANT, talent_record_id: recordId, field_name: 'last_name', new_evidence_id: ev });
      await repo.recordPendingContradiction({ tenant_id: TENANT, talent_record_id: recordId, field_name: 'last_name', new_evidence_id: ev });

      const rows = await repo.listPendingContradictions(recordId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ field_name: 'last_name', new_evidence_id: ev, status: 'pending' });
    });

    it('deleting the TalentRecord cascade-purges its projection annotations (FK)', async () => {
      const recordId = await seedRecord();
      await repo.upsertFieldProvenance({ tenant_id: TENANT, talent_record_id: recordId, field_name: 'email1', evidence_id: uuidv7() });
      await repo.recordPendingContradiction({ tenant_id: TENANT, talent_record_id: recordId, field_name: 'last_name', new_evidence_id: uuidv7() });

      await prisma.$executeRawUnsafe(`DELETE FROM "talent_record"."TalentRecord" WHERE id = '${recordId}'::uuid`);

      expect(await repo.listFieldProvenance(recordId)).toHaveLength(0);
      expect(await repo.listPendingContradictions(recordId)).toHaveLength(0);
    });

    // ---- Slice-B2 — the pending poll (join incumbent) + markResolved ----------

    it('findPendingContradictions joins the incumbent evidence + markResolved drops the row from the poll', async () => {
      const recordId = await seedRecord();
      const incumbent = uuidv7();
      const challenger = uuidv7();
      // The field currently projects `incumbent` (create/null-fill provenance);
      // a newer differing arrival recorded `challenger` as pending.
      await repo.upsertFieldProvenance({ tenant_id: TENANT, talent_record_id: recordId, field_name: 'email1', evidence_id: incumbent });
      await repo.recordPendingContradiction({ tenant_id: TENANT, talent_record_id: recordId, field_name: 'email1', new_evidence_id: challenger });

      const pending = await repo.findPendingContradictions({ limit: 100 });
      const mine = pending.find((p) => p.talent_record_id === recordId && p.field_name === 'email1');
      expect(mine).toBeDefined();
      expect(mine?.new_evidence_id).toBe(challenger);
      expect(mine?.incumbent_evidence_id).toBe(incumbent);

      // markResolved → the row leaves the pending poll (idempotency gate).
      if (mine !== undefined) await repo.markContradictionResolved(mine.id);
      const after = await repo.findPendingContradictions({ limit: 100 });
      expect(after.some((p) => p.id === mine?.id)).toBe(false);
    });

    it('a pending row whose field has NO provenance surfaces incumbent_evidence_id = null (LEFT JOIN)', async () => {
      const recordId = await seedRecord();
      const challenger = uuidv7();
      // No provenance for phone_cell → the invariant-violation case.
      await repo.recordPendingContradiction({ tenant_id: TENANT, talent_record_id: recordId, field_name: 'phone_cell', new_evidence_id: challenger });

      const pending = await repo.findPendingContradictions({ limit: 100 });
      const mine = pending.find((p) => p.talent_record_id === recordId && p.field_name === 'phone_cell');
      expect(mine).toBeDefined();
      expect(mine?.incumbent_evidence_id).toBeNull();
    });
  },
);
