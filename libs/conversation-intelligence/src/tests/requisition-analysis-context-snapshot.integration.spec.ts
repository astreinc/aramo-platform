import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { makeMockLogger } from '@aramo/common';
import { RequisitionPrismaService } from '@aramo/requisition';
import {
  JobDomainRepository,
  PrismaService as JobDomainPrismaService,
  goldenProfileContentToStorage,
  type GoldenProfileContent,
} from '@aramo/job-domain';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RequisitionAnalysisContextSnapshotRepository } from '../lib/requisition-analysis-context-snapshot.repository.js';
import { RequisitionAnalysisContextSnapshotService } from '../lib/requisition-analysis-context-snapshot.service.js';
import { RequisitionGoldenProfileContextReader } from '../lib/reader/requisition-golden-profile-context.reader.js';
import {
  buildRequisitionAnalysisContext,
  REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION,
  type RequisitionAnalysisSource,
} from '../lib/dto/requisition-analysis-context.js';

// CI-B2 — integration spec for libs/conversation-intelligence (real
// Postgres 17). Part A exercises the snapshot substrate on the CI schema
// alone; Part B applies the requisition + job_domain schemas and drives
// the real reader + service end-to-end to prove immutability under
// source mutation.

const CI_MIGRATION = resolve(
  __dirname,
  '../../prisma/migrations/20260907130000_ci_requisition_analysis_context_init/migration.sql',
);

function orderedMigrations(libRelPrisma: string): string[] {
  const dir = resolve(__dirname, libRelPrisma);
  return readdirSync(dir)
    .filter((n) => n !== 'migration_lock.toml')
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

const REQUISITION_MIGRATIONS = orderedMigrations(
  '../../../requisition/prisma/migrations',
);
const JOB_DOMAIN_MIGRATIONS = orderedMigrations(
  '../../../job-domain/prisma/migrations',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';

async function applyMigrations(client: { $executeRawUnsafe: (s: string) => Promise<unknown> }, files: string[]): Promise<void> {
  for (const file of files) {
    const sql = readFileSync(file, 'utf8');
    for (const stmt of splitDdl(sql)) {
      const trimmed = stmt.trim();
      if (trimmed.length === 0) continue;
      await client.$executeRawUnsafe(trimmed);
    }
  }
}

const CONTENT_A: GoldenProfileContent = {
  role_family: 'software_engineering',
  seniority_level: 'senior',
  jd_text: 'Build the platform (A).',
  generated_by: 'manual',
  required_skills: [{ name: 'TypeScript', min_years: 5 }],
  preferred_skills: [{ name: 'Rust' }],
  critical_skills: [{ name: 'TypeScript' }],
  experience: { total_years: 8, industries: ['staffing'] },
  constraints: { work_authorization: 'us_citizen' },
};

const CONTENT_B: GoldenProfileContent = {
  ...CONTENT_A,
  jd_text: 'Rewritten profile (B).',
  required_skills: [{ name: 'Go', min_years: 3 }],
  critical_skills: [{ name: 'Go' }],
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'libs/conversation-intelligence — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let ci: PrismaService;
    let reqPrisma: RequisitionPrismaService;
    let jobDomainPrisma: JobDomainPrismaService;
    let repo: RequisitionAnalysisContextSnapshotRepository;
    let service: RequisitionAnalysisContextSnapshotService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      ci = new PrismaService(url);
      reqPrisma = new RequisitionPrismaService(url);
      jobDomainPrisma = new JobDomainPrismaService(url);
      await ci.$connect();
      await reqPrisma.$connect();
      await jobDomainPrisma.$connect();

      // Apply source schemas first (Part B), then the CI snapshot schema.
      await applyMigrations(reqPrisma, REQUISITION_MIGRATIONS);
      await applyMigrations(jobDomainPrisma, JOB_DOMAIN_MIGRATIONS);
      await applyMigrations(ci, [CI_MIGRATION]);

      repo = new RequisitionAnalysisContextSnapshotRepository(ci, makeMockLogger());
      const jobDomain = new JobDomainRepository(jobDomainPrisma);
      const reader = new RequisitionGoldenProfileContextReader(reqPrisma, jobDomain);
      service = new RequisitionAnalysisContextSnapshotService(
        reader,
        repo,
        makeMockLogger(),
      );
    }, 240_000);

    afterAll(async () => {
      await ci?.$disconnect();
      await reqPrisma?.$disconnect();
      await jobDomainPrisma?.$disconnect();
      await container?.stop();
    });

    // ---- Part A — snapshot substrate (CI schema) --------------------

    function directSource(
      overrides: Partial<RequisitionAnalysisSource> = {},
    ): RequisitionAnalysisSource {
      return {
        tenant_id: TENANT_A,
        requisition_id: randomUUID(),
        source_requisition_version: 2,
        golden_profile_id: null,
        title: 'Substrate Role',
        job_type: 'contract',
        labor_category: null,
        role_family: null,
        seniority_level: null,
        city: 'Austin',
        state: 'TX',
        postal_code: null,
        work_arrangement: 'remote',
        onsite_days_per_week: null,
        travel_percent: null,
        relocation_offered: false,
        duration_value: null,
        duration_unit: null,
        hours_per_week: null,
        extension_possible: false,
        work_authorization: 'any',
        golden_profile_content: null,
        ...overrides,
      };
    }

    async function persist(source: RequisitionAnalysisSource) {
      return repo.createSnapshot({
        id: randomUUID(),
        tenant_id: source.tenant_id,
        requisition_id: source.requisition_id,
        source_requisition_version: source.source_requisition_version,
        golden_profile_id: source.golden_profile_id,
        snapshot_schema_version: REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION,
        context: buildRequisitionAnalysisContext(source),
        captured_at: new Date(),
      });
    }

    it('creates a snapshot and reads it back (TEST 6 — schema version persisted)', async () => {
      const created = await persist(directSource({ source_requisition_version: 4 }));
      const read = await repo.findById(TENANT_A, created.id);
      expect(read).not.toBeNull();
      expect(read?.snapshot_schema_version).toBe(REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION);
      expect(read?.source_requisition_version).toBe(4);
      expect(read?.context.role.title).toBe('Substrate Role');
    });

    it('TEST 4 — cross-tenant read is concealed (findById is tenant-scoped)', async () => {
      const created = await persist(directSource({ tenant_id: TENANT_A }));
      expect(await repo.findById(TENANT_A, created.id)).not.toBeNull();
      // Same UUID under the wrong tenant does not leak existence.
      expect(await repo.findById(TENANT_B, created.id)).toBeNull();
    });

    it('TEST 2 — a raw SQL UPDATE on the snapshot is rejected by the DB trigger', async () => {
      const created = await persist(directSource());
      await expect(
        ci.$executeRawUnsafe(
          `UPDATE conversation_intelligence."RequisitionAnalysisContextSnapshot"
             SET source_requisition_version = 999
             WHERE id = '${created.id}'::uuid`,
        ),
      ).rejects.toThrow(/RequisitionAnalysisContextSnapshot is immutable/);
    });

    // ---- Part B — end-to-end through the real reader + service ------

    async function seedRequisition(args: {
      tenant_id: string;
      title: string;
      city: string;
      version: number;
      golden_profile_id?: string | null;
      withFinancials?: boolean;
    }): Promise<string> {
      const id = randomUUID();
      await reqPrisma.requisition.create({
        data: {
          id,
          tenant_id: args.tenant_id,
          title: args.title,
          requisition_number: Math.floor(Math.random() * 1_000_000) + 1000,
          company_id: randomUUID(),
          city: args.city,
          state: 'TX',
          work_arrangement: 'hybrid',
          job_type: 'contract',
          work_authorization: 'us_citizen',
          version: args.version,
          golden_profile_id: args.golden_profile_id ?? null,
          ...(args.withFinancials
            ? {
                pay_rate_amount: '145.00',
                bill_rate_amount: '210.00',
                salary_amount: '190000.00',
                target_margin_percent: '31.00',
                min_bill_rate: '180.00',
                max_pay_rate: '160.00',
              }
            : {}),
        },
      });
      return id;
    }

    async function seedGoldenProfile(
      tenant_id: string,
      content: GoldenProfileContent,
    ): Promise<string> {
      const id = randomUUID();
      const storage = goldenProfileContentToStorage(content);
      await jobDomainPrisma.goldenProfile.create({
        data: {
          id,
          tenant_id,
          job_id: randomUUID(),
          skills: storage.skills as never,
          experience: storage.experience as never,
          constraints: storage.constraints as never,
          critical_skills: storage.critical_skills,
        },
      });
      return id;
    }

    it('TEST 1 + TEST 5 — later Requisition edit does not change the snapshot (non-vacuous)', async () => {
      const reqId = await seedRequisition({
        tenant_id: TENANT_A,
        title: 'Role A',
        city: 'Austin',
        version: 5,
      });

      const snap = await service.captureSnapshot({ tenant_id: TENANT_A, requisition_id: reqId });
      expect(snap.context.role.title).toBe('Role A');
      expect(snap.context.location.city).toBe('Austin');
      // TEST 5 — the exact source CAS token was captured.
      expect(snap.source_requisition_version).toBe(5);

      // Mutate the source Requisition to state B.
      await reqPrisma.requisition.update({
        where: { id: reqId },
        data: { title: 'Role B', city: 'Dallas', version: 6 },
      });

      // The snapshot still reflects state A.
      const readBack = await service.getSnapshot(TENANT_A, snap.id);
      expect(readBack?.context.role.title).toBe('Role A');
      expect(readBack?.context.location.city).toBe('Austin');
      expect(readBack?.source_requisition_version).toBe(5);

      // Non-vacuity: the live source genuinely changed (a fresh capture
      // would now reflect B), so the snapshot's stability is meaningful.
      const snapB = await service.captureSnapshot({ tenant_id: TENANT_A, requisition_id: reqId });
      expect(snapB.context.role.title).toBe('Role B');
      expect(snapB.context.location.city).toBe('Dallas');
      expect(snapB.source_requisition_version).toBe(6);
    });

    it('TEST 3 — cross-tenant capture is concealed as NOT_FOUND', async () => {
      const reqId = await seedRequisition({
        tenant_id: TENANT_A,
        title: 'Tenant A Role',
        city: 'Austin',
        version: 1,
      });
      // Tenant B cannot snapshot Tenant A's requisition.
      await expect(
        service.captureSnapshot({ tenant_id: TENANT_B, requisition_id: reqId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    });

    it('TEST 8 — populated financial columns never enter the snapshot', async () => {
      const reqId = await seedRequisition({
        tenant_id: TENANT_A,
        title: 'Financial Role',
        city: 'Austin',
        version: 1,
        withFinancials: true,
      });
      const snap = await service.captureSnapshot({ tenant_id: TENANT_A, requisition_id: reqId });
      const serialized = JSON.stringify(snap.context);
      for (const banned of ['145.00', '210.00', '190000.00', '31.00', '180.00', '160.00', 'pay_rate', 'bill_rate', 'target_margin', 'min_bill_rate', 'max_pay_rate', 'salary']) {
        expect(serialized).not.toContain(banned);
      }
    });

    it('TEST 9 — later GoldenProfile edit does not change the snapshot content', async () => {
      const gpId = await seedGoldenProfile(TENANT_A, CONTENT_A);
      const reqId = await seedRequisition({
        tenant_id: TENANT_A,
        title: 'Profiled Role',
        city: 'Austin',
        version: 1,
        golden_profile_id: gpId,
      });

      const snap = await service.captureSnapshot({ tenant_id: TENANT_A, requisition_id: reqId });
      expect(snap.golden_profile_id).toBe(gpId);
      expect(snap.context.golden_profile?.content.required_skills).toEqual([
        { name: 'TypeScript', min_years: 5 },
      ]);

      // Mutate the GoldenProfile in place (it is mutable, no version).
      const storageB = goldenProfileContentToStorage(CONTENT_B);
      await jobDomainPrisma.goldenProfile.update({
        where: { id: gpId },
        data: {
          skills: storageB.skills as never,
          experience: storageB.experience as never,
          constraints: storageB.constraints as never,
          critical_skills: storageB.critical_skills,
        },
      });

      // The snapshot's captured content is stable.
      const readBack = await service.getSnapshot(TENANT_A, snap.id);
      expect(readBack?.context.golden_profile?.content.required_skills).toEqual([
        { name: 'TypeScript', min_years: 5 },
      ]);
    });

    it('TEST 10 — capture does not mutate the source Requisition (no lifecycle side effect)', async () => {
      const reqId = await seedRequisition({
        tenant_id: TENANT_A,
        title: 'Untouched Role',
        city: 'Austin',
        version: 3,
      });
      const before = await reqPrisma.requisition.findUniqueOrThrow({ where: { id: reqId } });
      await service.captureSnapshot({ tenant_id: TENANT_A, requisition_id: reqId });
      const after = await reqPrisma.requisition.findUniqueOrThrow({ where: { id: reqId } });
      expect(after.status).toBe(before.status);
      expect(after.version).toBe(before.version);
      expect(after.title).toBe(before.title);
      expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    });
  },
);

// Comment-aware, dollar-quote-aware DDL splitter. Splits on `;` only
// outside `$$`-dollar-quoted regions AND outside `--` line comments —
// several older requisition migrations carry a literal `;` inside a `--`
// comment, which a comment-blind splitter would wrongly split on
// (Aramo substrate trap: splitDdl is comment-blind).
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (!inDollar && sql.startsWith('--', i)) {
      inLineComment = true;
      current += ch;
      continue;
    }
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
