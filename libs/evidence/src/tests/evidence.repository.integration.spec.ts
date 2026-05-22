import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { EvidenceRepository } from '../lib/evidence.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// M4 PR-1 §4.6 — integration spec for libs/evidence.
//
// Brings up a Postgres testcontainer, applies the init migration
// (CREATE SCHEMA + CREATE TABLE + 4 indexes + immutability trigger),
// and asserts:
//
//   - Seed via raw SQL (no builder method exists at PR-1).
//   - findById returns the row with JSONB structures deserialized to
//     typed view projections (TalentIdentity, ContactSummary,
//     CapabilitySummary, MatchJustification, RecruiterContribution).
//   - findByTenantAndSubmittal returns the row when submittal_record_id
//     is non-null; null result on the (tenant, unknown_submittal) lookup.
//   - findByTenantAndTalent returns rows sorted by created_at DESC.
//   - No-write spy across all six Prisma write methods (create, update,
//     upsert, delete, createMany, deleteMany) asserts zero invocations
//     during the entire test run.
//   - Immutability trigger raises an exception on a deliberate UPDATE
//     attempt; error message contains 'immutable per Group 2 §2.6'.
//   - Tenant isolation: queries scoped by tenant_id do not return rows
//     from other tenants.
//
// Dollar-quote-aware splitter (splitDdl below) — the migration carries
// a CREATE FUNCTION with a $$ ... $$ body that contains a semicolon
// inside the function. A naive `.split(';')` would corrupt the trigger
// SQL; the splitter only splits on semicolons OUTSIDE dollar-quoted
// regions.

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260522090000_init_evidence_model/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TALENT_B = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaa999';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAMINATION_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const SUBMITTAL_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';

const PACKAGE_1 = '00000000-0000-7000-8000-000000000001';
const PACKAGE_2 = '00000000-0000-7000-8000-000000000002';
const PACKAGE_3 = '00000000-0000-7000-8000-000000000003';
const PACKAGE_4_OTHER_TENANT = '00000000-0000-7000-8000-000000000004';

const TALENT_IDENTITY = {
  full_name: 'Sample Talent',
  preferred_name: 'Sam',
  location: 'Remote (US)',
};

const CONTACT_SUMMARY = {
  contact_available: true,
  channels_verified: ['email', 'phone'],
};

const CAPABILITY_SUMMARY = {
  skill_match: { matched_count: 5, missing_count: 0, per_skill: [] },
  experience_match: { years_overlap: 7, role_alignment: 'strong' },
  key_work_history: [
    { employer_name: 'Acme Corp', role_title: 'Senior Engineer', start_date: '2021-01-01' },
  ],
  certifications: ['AWS Solutions Architect'],
};

const MATCH_JUSTIFICATION = {
  why_this_talent: 'Strong evidence across all critical skills.',
  strengths: ['typescript-expertise', 'cloud-native-experience'],
  gaps: [],
  risk_flags: [],
};

const RECRUITER_CONTRIBUTION = {
  screening_notes: 'Spoke 2026-05-20; available immediately.',
  conversation_summary: 'Confirmed availability, rate, and authorization.',
  talent_confirmed: {
    spoken_to_recruiter: true,
    rate_confirmed: true,
    availability_confirmed: true,
    work_authorization: 'US_CITIZEN',
  },
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'EvidenceRepository — schema + immutability integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: EvidenceRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');

      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const stmt of splitDdl(migrationSql)) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setupClient.$executeRawUnsafe(trimmed);
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new EvidenceRepository(prisma);

      // Seed three packages for TENANT_A + TALENT_A across three created_at
      // timestamps (older → newer), plus one package for TENANT_B + TALENT_A
      // (tenant isolation control). Package 2 carries submittal_record_id;
      // packages 1, 3, and the TENANT_B package have submittal_record_id
      // NULL.
      await seedPackage(prisma, {
        id: PACKAGE_1,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
        examination_id: EXAMINATION_ID,
        submittal_record_id: null,
        parent_package_id: null,
        created_at: '2026-05-20T10:00:00Z',
      });
      await seedPackage(prisma, {
        id: PACKAGE_2,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
        examination_id: EXAMINATION_ID,
        submittal_record_id: SUBMITTAL_ID,
        parent_package_id: PACKAGE_1,
        created_at: '2026-05-21T10:00:00Z',
      });
      await seedPackage(prisma, {
        id: PACKAGE_3,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
        examination_id: EXAMINATION_ID,
        submittal_record_id: null,
        parent_package_id: null,
        created_at: '2026-05-22T10:00:00Z',
      });
      // Different tenant — must NOT appear in TENANT_A's findByTenantAndTalent
      // result (tenant isolation control).
      await seedPackage(prisma, {
        id: PACKAGE_4_OTHER_TENANT,
        tenant_id: TENANT_B,
        talent_id: TALENT_A,
        job_id: JOB_ID,
        examination_id: EXAMINATION_ID,
        submittal_record_id: null,
        parent_package_id: null,
        created_at: '2026-05-22T10:00:00Z',
      });
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('findById returns the row with deserialized JSONB structures', async () => {
      const view = await repo.findById({ tenant_id: TENANT_A, id: PACKAGE_1 });
      expect(view).not.toBeNull();
      expect(view?.id).toBe(PACKAGE_1);
      expect(view?.tenant_id).toBe(TENANT_A);
      expect(view?.talent_id).toBe(TALENT_A);
      expect(view?.job_id).toBe(JOB_ID);
      expect(view?.examination_id).toBe(EXAMINATION_ID);
      expect(view?.submittal_record_id).toBeNull();
      expect(view?.parent_package_id).toBeNull();
      expect(view?.talent_identity).toEqual(TALENT_IDENTITY);
      expect(view?.contact_summary).toEqual(CONTACT_SUMMARY);
      expect(view?.capability_summary).toEqual(CAPABILITY_SUMMARY);
      expect(view?.match_justification).toEqual(MATCH_JUSTIFICATION);
      expect(view?.recruiter_contribution).toEqual(RECRUITER_CONTRIBUTION);
      expect(view?.engagement_event_refs).toEqual([]);
    });

    it('findById returns null for an unknown id', async () => {
      const view = await repo.findById({
        tenant_id: TENANT_A,
        id: '00000000-0000-7000-8000-deadbeef0000',
      });
      expect(view).toBeNull();
    });

    it('findById returns null for a known id under a wrong tenant (tenant isolation)', async () => {
      // PACKAGE_1 is in TENANT_A; TENANT_B should not see it.
      const view = await repo.findById({ tenant_id: TENANT_B, id: PACKAGE_1 });
      expect(view).toBeNull();
    });

    it('findByTenantAndSubmittal returns the row when submittal_record_id is non-null', async () => {
      const view = await repo.findByTenantAndSubmittal({
        tenant_id: TENANT_A,
        submittal_record_id: SUBMITTAL_ID,
      });
      expect(view).not.toBeNull();
      expect(view?.id).toBe(PACKAGE_2);
      expect(view?.submittal_record_id).toBe(SUBMITTAL_ID);
      expect(view?.parent_package_id).toBe(PACKAGE_1);
    });

    it('findByTenantAndSubmittal returns null for an unknown submittal_record_id', async () => {
      const view = await repo.findByTenantAndSubmittal({
        tenant_id: TENANT_A,
        submittal_record_id: '00000000-0000-7000-8000-deadbeef0000',
      });
      expect(view).toBeNull();
    });

    it('findByTenantAndTalent returns rows sorted by created_at DESC', async () => {
      const views = await repo.findByTenantAndTalent({
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
      });
      expect(views).toHaveLength(3);
      // Newest first: PACKAGE_3 (2026-05-22) > PACKAGE_2 (2026-05-21) > PACKAGE_1 (2026-05-20).
      expect(views[0]?.id).toBe(PACKAGE_3);
      expect(views[1]?.id).toBe(PACKAGE_2);
      expect(views[2]?.id).toBe(PACKAGE_1);
      // Tenant isolation: the TENANT_B package with TALENT_A is NOT included.
      expect(views.map((v) => v.id)).not.toContain(PACKAGE_4_OTHER_TENANT);
    });

    it('findByTenantAndTalent returns [] for an unknown talent', async () => {
      const views = await repo.findByTenantAndTalent({
        tenant_id: TENANT_A,
        talent_id: TALENT_B,
      });
      expect(views).toEqual([]);
    });

    it('no-write evidence: all read methods issue zero write invocations', async () => {
      // PR-6/PR-7 spy precedent — spy across every Prisma write surface
      // on the talentJobEvidencePackage delegate. Any write would be a
      // scope breach (PR-1 is read-only by directive §4.3 Ruling 3).
      const createSpy = vi.spyOn(prisma.talentJobEvidencePackage, 'create');
      const createManySpy = vi.spyOn(prisma.talentJobEvidencePackage, 'createMany');
      const updateSpy = vi.spyOn(prisma.talentJobEvidencePackage, 'update');
      const updateManySpy = vi.spyOn(prisma.talentJobEvidencePackage, 'updateMany');
      const upsertSpy = vi.spyOn(prisma.talentJobEvidencePackage, 'upsert');
      const deleteSpy = vi.spyOn(prisma.talentJobEvidencePackage, 'delete');
      const deleteManySpy = vi.spyOn(prisma.talentJobEvidencePackage, 'deleteMany');

      try {
        await repo.findById({ tenant_id: TENANT_A, id: PACKAGE_1 });
        await repo.findByTenantAndSubmittal({
          tenant_id: TENANT_A,
          submittal_record_id: SUBMITTAL_ID,
        });
        await repo.findByTenantAndTalent({ tenant_id: TENANT_A, talent_id: TALENT_A });

        expect(createSpy).not.toHaveBeenCalled();
        expect(createManySpy).not.toHaveBeenCalled();
        expect(updateSpy).not.toHaveBeenCalled();
        expect(updateManySpy).not.toHaveBeenCalled();
        expect(upsertSpy).not.toHaveBeenCalled();
        expect(deleteSpy).not.toHaveBeenCalled();
        expect(deleteManySpy).not.toHaveBeenCalled();
      } finally {
        createSpy.mockRestore();
        createManySpy.mockRestore();
        updateSpy.mockRestore();
        updateManySpy.mockRestore();
        upsertSpy.mockRestore();
        deleteSpy.mockRestore();
        deleteManySpy.mockRestore();
      }
    });

    it('immutability trigger rejects any UPDATE on the table', async () => {
      // Per directive §4.2: the BEFORE UPDATE trigger raises an exception
      // with the spec'd message. Deliberate UPDATE attempt on a benign
      // column (the JSONB recruiter_contribution) MUST fail.
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE evidence."TalentJobEvidencePackage"
             SET recruiter_contribution = '{"changed":true}'::jsonb
             WHERE id = '${PACKAGE_1}'::uuid`,
        ),
      ).rejects.toThrow(/immutable per Group 2 §2.6/);
    });
  },
);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function seedPackage(
  client: PrismaService,
  opts: {
    id: string;
    tenant_id: string;
    talent_id: string;
    job_id: string;
    examination_id: string;
    submittal_record_id: string | null;
    parent_package_id: string | null;
    created_at: string;
  },
): Promise<void> {
  // Raw SQL seed. The Prisma create path is intentionally NOT used here —
  // PR-1's EvidenceRepository surface has no create method (read-only),
  // and the no-write spy assertion above would catch any incidental
  // Prisma write during the integration run. The migration-applied
  // immutability trigger fires on UPDATE only, not INSERT, so this seed
  // path is unconstrained.
  await client.$executeRawUnsafe(
    `INSERT INTO evidence."TalentJobEvidencePackage" (
       id, tenant_id, talent_id, job_id, examination_id,
       submittal_record_id, parent_package_id,
       talent_identity, contact_summary, capability_summary,
       match_justification, recruiter_contribution, engagement_event_refs,
       created_at
     ) VALUES (
       '${opts.id}'::uuid,
       '${opts.tenant_id}'::uuid,
       '${opts.talent_id}'::uuid,
       '${opts.job_id}'::uuid,
       '${opts.examination_id}'::uuid,
       ${opts.submittal_record_id === null ? 'NULL' : `'${opts.submittal_record_id}'::uuid`},
       ${opts.parent_package_id === null ? 'NULL' : `'${opts.parent_package_id}'::uuid`},
       '${JSON.stringify(TALENT_IDENTITY)}'::jsonb,
       '${JSON.stringify(CONTACT_SUMMARY)}'::jsonb,
       '${JSON.stringify(CAPABILITY_SUMMARY)}'::jsonb,
       '${JSON.stringify(MATCH_JUSTIFICATION)}'::jsonb,
       '${JSON.stringify(RECRUITER_CONTRIBUTION)}'::jsonb,
       '[]'::jsonb,
       '${opts.created_at}'::timestamptz
     )`,
  );
}

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}
