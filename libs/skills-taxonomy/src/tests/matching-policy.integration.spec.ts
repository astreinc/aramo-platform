import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import {
  MatchingPolicyRepository,
  MatchingPolicyVersionNotFoundError,
} from '../lib/matching-policy.repository.js';

// ATI-SEP-1 A2 A-c (P1) — the platform-owned MatchingPolicy store against a real
// Postgres 17. Proves: (1) the migration seeds exactly one ACTIVE version 1 carrying
// the pre-policy §2.5 constants; (2) createVersion appends a DRAFT with the next
// number + a CREATED audit row and never moves the ACTIVE version; (3) activateVersion
// swaps the ONE ACTIVE version atomically (previous → RETIRED) with an ACTIVATED audit
// row, re-activation of a RETIRED version is the rollback path, and activating the
// ACTIVE version is a no-op; (4) the DB enforces append-only content, no DELETE, one
// ACTIVE, and an append-only audit stream.
const MIGRATIONS = [
  '20260915140000_init_skill_registry',
  '20260915150000_skill_alias_version',
  '20260915160000_skill_relationship',
  '20260917210000_skill_tax_1f_governance',
  '20260917211000_skill_tax_1f_audit_append_only',
  '20260918120000_skill_tax_1f_b_governance_proposal_correction',
  '20261023140000_matching_policy',
].map((n) => resolve(__dirname, `../../prisma/migrations/${n}/migration.sql`));

const SEED_ID = '019a0000-0000-7000-8000-00000000a001';
const ACTOR = { id: '55555555-5555-7555-8555-555555555555', type: 'user' };

// The table engine.ts hard-coded before P1 (frozen literal).
const PRE_POLICY_CONSTANTS = {
  backend_engineer: { count: 2, requires_ingested: true },
  frontend_engineer: { count: 2, requires_ingested: true },
  fullstack_engineer: { count: 2, requires_ingested: true },
  devops_sre: { count: 2, requires_ingested: true },
  data_engineer: { count: 2, requires_ingested: true },
  architect: { count: 3, requires_ingested: true },
  qa_test_engineer: { count: 2, requires_ingested: true },
  product_project_manager: { count: 2, requires_ingested: false },
  business_analyst: { count: 2, requires_ingested: false },
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ATI-SEP-1 A2 A-c MatchingPolicy store (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let url: string;
    let prisma: PrismaService;
    let repo: MatchingPolicyRepository;

    async function applyMigrations(): Promise<void> {
      const db = new Client({ connectionString: url });
      await db.connect();
      await db.query('DROP SCHEMA IF EXISTS skills_taxonomy CASCADE');
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await db.end();
    }

    async function auditRows(): Promise<Array<{ event_type: string; subject_id: string; actor_id: string | null }>> {
      return prisma.$queryRawUnsafe(
        'SELECT event_type, subject_id::text AS subject_id, actor_id::text AS actor_id FROM skills_taxonomy."MatchingPolicyAuditEvent" ORDER BY created_at, id',
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      url = container.getConnectionUri();
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new MatchingPolicyRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    }, 60_000);

    // Re-apply the whole migration set per test so every case starts from the seed
    // (TRUNCATE would drop the seeded version 1).
    beforeEach(async () => {
      await applyMigrations();
    });

    it('seeds exactly one ACTIVE version 1 equal to the pre-policy constants', async () => {
      const versions = await repo.listVersions();
      expect(versions).toHaveLength(1);
      const active = await repo.getActive();
      expect(active?.id).toBe(SEED_ID);
      expect(active?.version_number).toBe(1);
      expect(active?.status).toBe('ACTIVE');
      expect(active?.evidence_thresholds).toEqual(PRE_POLICY_CONSTANTS);
      expect(active?.activated_at).not.toBeNull();
      const audit = await auditRows();
      expect(audit).toEqual([{ event_type: 'MATCHING_POLICY_VERSION_ACTIVATED', subject_id: SEED_ID, actor_id: null }]);
    });

    it('the seed is idempotent (re-running the seed inserts nothing)', async () => {
      const sql = readFileSync(MIGRATIONS[MIGRATIONS.length - 1] as string, 'utf8');
      const seed = sql.slice(sql.indexOf('-- matching-policy-v1-thresholds'));
      await prisma.$executeRawUnsafe(seed.slice(0, seed.indexOf('ON CONFLICT ("id") DO NOTHING;') + 30));
      expect(await repo.listVersions()).toHaveLength(1);
    });

    it('createVersion appends a DRAFT with the next number and audits it; ACTIVE is unchanged', async () => {
      const raised = { ...PRE_POLICY_CONSTANTS, architect: { count: 4, requires_ingested: true } };
      const v2 = await repo.createVersion({ evidence_thresholds: raised, note: 'raise architect', actor: ACTOR });
      expect(v2.version_number).toBe(2);
      expect(v2.status).toBe('DRAFT');
      expect(v2.created_by).toBe(ACTOR.id);
      expect(v2.evidence_thresholds).toEqual(raised);
      expect((await repo.getActive())?.id).toBe(SEED_ID);
      const v3 = await repo.createVersion({ evidence_thresholds: PRE_POLICY_CONSTANTS });
      expect(v3.version_number).toBe(3);
      expect((await repo.listVersions()).map((v) => v.version_number)).toEqual([3, 2, 1]);
      const audit = await auditRows();
      expect(audit.filter((a) => a.event_type === 'MATCHING_POLICY_VERSION_CREATED').map((a) => a.subject_id)).toEqual([
        v2.id,
        v3.id,
      ]);
    });

    it('concurrent createVersion calls receive distinct consecutive numbers', async () => {
      const made = await Promise.all(
        Array.from({ length: 5 }, () => repo.createVersion({ evidence_thresholds: PRE_POLICY_CONSTANTS })),
      );
      expect(made.map((v) => v.version_number).sort()).toEqual([2, 3, 4, 5, 6]);
    });

    it('activateVersion swaps the one ACTIVE version, audits it, and supports rollback', async () => {
      const v2 = await repo.createVersion({ evidence_thresholds: PRE_POLICY_CONSTANTS, actor: ACTOR });
      const first = await repo.activateVersion(v2.id, ACTOR);
      expect(first.changed).toBe(true);
      expect(first.row.status).toBe('ACTIVE');
      expect(first.row.activated_by).toBe(ACTOR.id);
      const v1 = await repo.getById(SEED_ID);
      expect(v1?.status).toBe('RETIRED');
      expect(v1?.retired_at).not.toBeNull();

      // Rollback: re-activate the RETIRED version 1.
      const back = await repo.activateVersion(SEED_ID, ACTOR);
      expect(back.changed).toBe(true);
      expect((await repo.getActive())?.id).toBe(SEED_ID);
      expect((await repo.getById(SEED_ID))?.retired_at).toBeNull();
      expect((await repo.getById(v2.id))?.status).toBe('RETIRED');

      const activations = (await auditRows()).filter((a) => a.event_type === 'MATCHING_POLICY_VERSION_ACTIVATED');
      expect(activations.map((a) => a.subject_id)).toEqual([SEED_ID, v2.id, SEED_ID]);
    });

    it('activating the ACTIVE version is a no-op (no write, no audit)', async () => {
      const before = await auditRows();
      const r = await repo.activateVersion(SEED_ID, ACTOR);
      expect(r.changed).toBe(false);
      expect(r.row.status).toBe('ACTIVE');
      expect(await auditRows()).toEqual(before);
    });

    it('activating an unknown id is refused', async () => {
      await expect(repo.activateVersion('019a0000-0000-7000-8000-00000000ffff', ACTOR)).rejects.toBeInstanceOf(
        MatchingPolicyVersionNotFoundError,
      );
    });

    it('the DB rejects a content change, a DELETE, a second ACTIVE, and an audit mutation', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE skills_taxonomy."MatchingPolicyVersion" SET evidence_thresholds = '{}'::jsonb WHERE id = '${SEED_ID}'`,
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        prisma.$executeRawUnsafe(`DELETE FROM skills_taxonomy."MatchingPolicyVersion" WHERE id = '${SEED_ID}'`),
      ).rejects.toThrow(/append-only/);
      const v2 = await repo.createVersion({ evidence_thresholds: PRE_POLICY_CONSTANTS });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE skills_taxonomy."MatchingPolicyVersion" SET status = 'ACTIVE' WHERE id = '${v2.id}'`,
        ),
      ).rejects.toThrow(/MatchingPolicyVersion_one_active_key/);
      await expect(
        prisma.$executeRawUnsafe('DELETE FROM skills_taxonomy."MatchingPolicyAuditEvent"'),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE skills_taxonomy."MatchingPolicyAuditEvent" SET actor_type = 'x'`),
      ).rejects.toThrow(/append-only/);
    });
  },
);
