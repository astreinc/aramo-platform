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
import {
  composeProfileHydration,
  PROFILE_HYDRATION_FIELDS,
  type ProfileHydrationInputRecord,
} from '../lib/profile-hydration.js';

// TALENT-INTEL-1 TI-1E-A — end-to-end proof of the aggregate hydration
// projection against a real Postgres 17: the SAME read sequence the
// GET :id/profile-hydration route runs (findById projection + field-state read
// model → composeProfileHydration), plus the hard-HALT invariants the ruling
// fixed. This exercises the real TI-1D-A/B field-state substrate — NOT mocks.

const MIGRATIONS_DIR = resolve(__dirname, '../../prisma/migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
  .map((d) => d.name)
  .sort()
  .map((d) => resolve(MIGRATIONS_DIR, d, 'migration.sql'));

const TENANT = '11111111-1111-7111-8111-111111111111';

function splitDdl(sql: string): string[] {
  return sql
    .replace(/--[^\n]*$/gm, '')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'profile-hydration projection — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TalentRecordReconcileRepository;
    const talentId = uuidv7();

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

      // A record with: a value to be governed-cleared (work_authorization),
      // a reconciled value (city), a plain operational value (desired_pay),
      // a boolean (can_relocate), a mandatory contact (email1), and empties.
      await prisma.talentRecord.create({
        data: {
          id: talentId,
          tenant_id: TENANT,
          first_name: 'Ada',
          last_name: 'Lovelace',
          email1: 'ada@x.co',
          city: 'Austin',
          desired_pay: '$85/hr',
          can_relocate: true,
          is_hot: false,
          work_authorization: null,
        },
      });

      // Governed explicit clear on work_authorization (recruiter cleared + HOLD).
      await repo.upsertProfileFieldState({
        tenant_id: TENANT,
        talent_record_id: talentId,
        field_key: 'work_authorization',
        value_state: 'EXPLICITLY_CLEARED',
        source_type: 'MANUAL',
        projection_policy: 'HOLD',
      });
      // Reconciled provenance on city (no control row → RECONCILED, UNKNOWN default).
      await repo.upsertFieldProvenance({
        tenant_id: TENANT,
        talent_record_id: talentId,
        field_name: 'city',
        evidence_id: uuidv7(),
      });
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function hydrate() {
      const rec = (await prisma.talentRecord.findUnique({
        where: { id: talentId },
      })) as unknown as ProfileHydrationInputRecord;
      const rows = await repo.getFieldStateReadModel(talentId);
      return composeProfileHydration(talentId, rec, rows);
    }

    it('covers the complete governed editable field set', async () => {
      const res = await hydrate();
      expect(res.fields).toHaveLength(PROFILE_HYDRATION_FIELDS.length);
    });

    it('HALT: EXPLICITLY_CLEARED control wins end-to-end (null value, MANUAL/HOLD)', async () => {
      const f = (await hydrate()).fields.find((x) => x.field_key === 'work_authorization')!;
      expect(f.value_state).toBe('EXPLICITLY_CLEARED');
      expect(f.current_value).toBeNull();
      expect(f.source_type).toBe('MANUAL');
      expect(f.projection_policy).toBe('HOLD');
    });

    it('reconciled field → SET + RECONCILED + evidence linkage', async () => {
      const f = (await hydrate()).fields.find((x) => x.field_key === 'city')!;
      expect(f.current_value).toBe('Austin');
      expect(f.value_state).toBe('SET');
      expect(f.source_type).toBe('RECONCILED');
      expect(f.provenance).not.toBeNull();
    });

    it('HALT: operational-only field with a value → SET but NO fabricated provenance', async () => {
      const f = (await hydrate()).fields.find((x) => x.field_key === 'desired_pay')!;
      expect(f.current_value).toBe('$85/hr');
      expect(f.value_state).toBe('SET');
      expect(f.source_type).toBeNull();
      expect(f.provenance).toBeNull();
    });

    it('HALT: UNKNOWN stays UNKNOWN for a genuinely empty, ungoverned field', async () => {
      const f = (await hydrate()).fields.find((x) => x.field_key === 'notes')!;
      expect(f.value_state).toBe('UNKNOWN');
      expect(f.current_value).toBeNull();
      expect(f.source_type).toBeNull();
    });

    it('boolean typed end-to-end (not stringified)', async () => {
      const f = (await hydrate()).fields.find((x) => x.field_key === 'can_relocate')!;
      expect(f.current_value).toBe(true);
      expect(typeof f.current_value).toBe('boolean');
    });

    it('HALT: hydration is a pure READ — no field-state / provenance rows written', async () => {
      const before = await Promise.all([
        prisma.talentProfileFieldState.count(),
        prisma.talentRecordFieldProvenance.count(),
      ]);
      await hydrate();
      await hydrate();
      const after = await Promise.all([
        prisma.talentProfileFieldState.count(),
        prisma.talentRecordFieldProvenance.count(),
      ]);
      expect(after).toEqual(before);
    });
  },
);
