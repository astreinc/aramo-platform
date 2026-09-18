import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SkillRepository } from '../lib/skill.repository.js';
import { SkillAliasRepository } from '../lib/skill-alias.repository.js';
import { SkillVersionRepository } from '../lib/skill-version.repository.js';
import { SkillRelationshipRepository } from '../lib/skill-relationship.repository.js';
import { SkillRegistryService } from '../lib/skill-registry.service.js';

// SKILL-TAX-1F-B2 — the ratified correction-task matrix, proven end-to-end against a
// real Postgres 17. A governance mutation that can change canonicalization for
// already-stored evidence MUST emit exactly ONE durable SkillCorrectionTask,
// atomically; a mutation that cannot must emit NONE. This is the load-bearing seam
// the B1 propagation engine drains — a missing task is a silent divergence.
const MIGRATIONS = [
  '20260915140000_init_skill_registry',
  '20260915150000_skill_alias_version',
  '20260915160000_skill_relationship',
  '20260917210000_skill_tax_1f_governance',
  '20260917211000_skill_tax_1f_audit_append_only',
  '20260918120000_skill_tax_1f_b_governance_proposal_correction',
].map((n) => resolve(__dirname, `../../prisma/migrations/${n}/migration.sql`));

const ACTOR = { id: '55555555-5555-7555-8555-555555555555', type: 'user' };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SKILL-TAX-1F-B2 correction-task matrix (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let service: SkillRegistryService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await db.end();

      prisma = new PrismaService(url);
      await prisma.$connect();
      service = new SkillRegistryService(
        new SkillRepository(prisma),
        new SkillAliasRepository(prisma),
        new SkillVersionRepository(prisma),
        new SkillRelationshipRepository(prisma),
      );
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    }, 60_000);

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE skills_taxonomy."SkillAuditEvent", skills_taxonomy."SkillCorrectionTask", skills_taxonomy."SkillRelationship", skills_taxonomy."SkillVersion", skills_taxonomy."SkillAlias", skills_taxonomy."Skill" CASCADE',
      );
    });

    async function tasks(): Promise<Array<{ correction_type: string; from_canonical_skill_id: string | null; to_canonical_skill_id: string | null; surface_form: string | null }>> {
      return prisma.$queryRawUnsafe(
        'SELECT correction_type, from_canonical_skill_id, to_canonical_skill_id, surface_form FROM skills_taxonomy."SkillCorrectionTask" ORDER BY created_at ASC',
      );
    }

    it('createSkill emits NO correction task', async () => {
      await service.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      expect(await tasks()).toHaveLength(0);
    });

    it('updateSkill canonical_name change emits ONE OVERRIDE_CORRECTION keyed by the skill', async () => {
      const s = await service.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      await prisma.$executeRawUnsafe('TRUNCATE TABLE skills_taxonomy."SkillCorrectionTask"');
      await service.updateSkill(s.id, { canonicalName: 'Kubernetes Engine', actor: ACTOR });
      const t = await tasks();
      expect(t).toHaveLength(1);
      expect(t[0]!.correction_type).toBe('OVERRIDE_CORRECTION');
      expect(t[0]!.from_canonical_skill_id).toBe(s.id);
      expect(t[0]!.to_canonical_skill_id).toBeNull();
    });

    it('updateSkill description-only emits NO correction task', async () => {
      const s = await service.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      await prisma.$executeRawUnsafe('TRUNCATE TABLE skills_taxonomy."SkillCorrectionTask"');
      await service.updateSkill(s.id, { description: 'container orchestration', actor: ACTOR });
      expect(await tasks()).toHaveLength(0);
    });

    it('deactivate + reactivate each emit an OVERRIDE_CORRECTION keyed by the skill', async () => {
      const s = await service.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      await prisma.$executeRawUnsafe('TRUNCATE TABLE skills_taxonomy."SkillCorrectionTask"');
      await service.deactivateSkill(s.id, ACTOR);
      await service.reactivateSkill(s.id, ACTOR);
      const t = await tasks();
      expect(t).toHaveLength(2);
      expect(t.every((x) => x.correction_type === 'OVERRIDE_CORRECTION' && x.from_canonical_skill_id === s.id)).toBe(true);
    });

    it('addAlias emits ONE ALIAS_CORRECTION keyed by the alias surface; removeAlias emits another', async () => {
      const s = await service.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      await prisma.$executeRawUnsafe('TRUNCATE TABLE skills_taxonomy."SkillCorrectionTask"');
      const alias = await service.addAlias({ skillId: s.id, alias: 'K8s', aliasType: 'ABBREVIATION', actor: ACTOR });
      let t = await tasks();
      expect(t).toHaveLength(1);
      expect(t[0]!.correction_type).toBe('ALIAS_CORRECTION');
      expect(t[0]!.surface_form).toBe('K8s');
      expect(t[0]!.from_canonical_skill_id).toBeNull();

      await prisma.$executeRawUnsafe('TRUNCATE TABLE skills_taxonomy."SkillCorrectionTask"');
      await service.removeAlias(alias.id, ACTOR);
      t = await tasks();
      expect(t).toHaveLength(1);
      expect(t[0]!.correction_type).toBe('ALIAS_CORRECTION');
    });

    it('addVersion + updateVersion each emit an OVERRIDE_CORRECTION keyed by the owning skill', async () => {
      const s = await service.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      await prisma.$executeRawUnsafe('TRUNCATE TABLE skills_taxonomy."SkillCorrectionTask"');
      const v = await service.addVersion({ skillId: s.id, version: '1.29', actor: ACTOR });
      let t = await tasks();
      expect(t).toHaveLength(1);
      expect(t[0]!.correction_type).toBe('OVERRIDE_CORRECTION');
      expect(t[0]!.from_canonical_skill_id).toBe(s.id);

      await prisma.$executeRawUnsafe('TRUNCATE TABLE skills_taxonomy."SkillCorrectionTask"');
      await service.updateVersion(v.id, { status: 'inactive', actor: ACTOR });
      t = await tasks();
      expect(t).toHaveLength(1);
      expect(t[0]!.correction_type).toBe('OVERRIDE_CORRECTION');
      expect(t[0]!.from_canonical_skill_id).toBe(s.id);
    });

    it('addRelationship + removeRelationship emit NO correction task (taxonomy intelligence never alters canonical identity)', async () => {
      const a = await service.createSkill({ canonicalName: 'React', actor: ACTOR });
      const b = await service.createSkill({ canonicalName: 'JavaScript', actor: ACTOR });
      await prisma.$executeRawUnsafe('TRUNCATE TABLE skills_taxonomy."SkillCorrectionTask"');
      const rel = await service.addRelationship({
        sourceSkillId: a.id,
        targetSkillId: b.id,
        relationshipType: 'BUILT_ON',
        source: 'ADMIN_CURATED',
        actor: ACTOR,
      });
      expect(await tasks()).toHaveLength(0);
      await service.removeRelationship(rel.id, ACTOR);
      expect(await tasks()).toHaveLength(0);
    });

    it('recordCanonicalizationOverride emits an OVERRIDE_CORRECTION keyed by subject + payload surface', async () => {
      const s = await service.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      await prisma.$executeRawUnsafe('TRUNCATE TABLE skills_taxonomy."SkillCorrectionTask"');
      await service.recordCanonicalizationOverride({
        subjectId: s.id,
        actor: ACTOR,
        payload: { surface_form: 'kubernetes', note: 'manual correction' },
      });
      const t = await tasks();
      expect(t).toHaveLength(1);
      expect(t[0]!.correction_type).toBe('OVERRIDE_CORRECTION');
      expect(t[0]!.from_canonical_skill_id).toBe(s.id);
      expect(t[0]!.surface_form).toBe('kubernetes');
    });

    it('mergeSkill emits ONE SKILL_MERGE task carrying loser→winner', async () => {
      const loser = await service.createSkill({ canonicalName: 'K8s Platform', actor: ACTOR });
      const winner = await service.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      await prisma.$executeRawUnsafe('TRUNCATE TABLE skills_taxonomy."SkillCorrectionTask"');
      await service.mergeSkill(loser.id, winner.id, ACTOR);
      const t = await tasks();
      expect(t).toHaveLength(1);
      expect(t[0]!.correction_type).toBe('SKILL_MERGE');
      expect(t[0]!.from_canonical_skill_id).toBe(loser.id);
      expect(t[0]!.to_canonical_skill_id).toBe(winner.id);
    });
  },
);
