import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SkillRepository } from '../lib/skill.repository.js';
import { SkillAliasRepository } from '../lib/skill-alias.repository.js';
import { SkillVersionRepository } from '../lib/skill-version.repository.js';
import {
  SkillRegistryService,
  SkillAliasConflictError,
  SkillVersionConflictError,
  SkillNotFoundError,
} from '../lib/skill-registry.service.js';

// SKILL-TAX-1B — governed aliases + versions (real Postgres 17).
//
// MIGRATIONS list (applied in order):
//   - 20260915140000_init_skill_registry
//   - 20260915150000_skill_alias_version
const MIGRATIONS = [
  resolve(__dirname, '../../prisma/migrations/20260915140000_init_skill_registry/migration.sql'),
  resolve(__dirname, '../../prisma/migrations/20260915150000_skill_alias_version/migration.sql'),
  // SKILL-TAX-1F-A — Skill.merged_into_skill_id (regen client SELECTs it). Split-safe.
  resolve(__dirname, '../../prisma/migrations/20260917210000_skill_tax_1f_governance/migration.sql'),
  // SKILL-TAX-1F-B2 — addAlias/addVersion now write a SkillCorrectionTask atomically;
  // its table is created here (regen client INSERTs it → curated list must include it).
  resolve(__dirname, '../../prisma/migrations/20260918120000_skill_tax_1f_b_governance_proposal_correction/migration.sql'),
];

const ACTOR = { id: '55555555-5555-7555-8555-555555555555', type: 'platform_admin' };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SkillRegistryService — aliases + versions integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let service: SkillRegistryService;
    let skillRepo: SkillRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of readFileSync(path, 'utf8').split(';')) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.$executeRawUnsafe(trimmed);
        }
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      skillRepo = new SkillRepository(prisma);
      service = new SkillRegistryService(
        skillRepo,
        new SkillAliasRepository(prisma),
        new SkillVersionRepository(prisma),
      );
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    }, 60_000);

    // Alias equivalence — K8s maps to the Kubernetes canonical Skill, and the
    // original surface form is preserved (canonicalization never rewrites it).
    it('maps an alias to a canonical Skill without altering canonical or surface values', async () => {
      const k8s = await service.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      const alias = await service.addAlias({
        skillId: k8s.id,
        alias: 'K8s',
        aliasType: 'ABBREVIATION',
        actor: ACTOR,
      });
      expect(alias.alias).toBe('K8s');
      expect(alias.normalized_alias).toBe('k8s');
      expect(alias.skill_id).toBe(k8s.id);

      const resolved = await service.findAliasBySurfaceForm('  K8S ');
      expect(resolved?.skill_id).toBe(k8s.id);
      // Canonical + surface unchanged by the alias.
      expect((await service.getSkillById(k8s.id))?.canonical_name).toBe('Kubernetes');
    });

    // normalized_alias is globally unique — an alias resolves to exactly one skill.
    it('rejects a duplicate normalized alias', async () => {
      const a = await service.createSkill({ canonicalName: 'Amazon Web Services', actor: ACTOR });
      await service.addAlias({ skillId: a.id, alias: 'AWS', aliasType: 'ABBREVIATION', actor: ACTOR });
      await expect(
        service.addAlias({ skillId: a.id, alias: 'aws', aliasType: 'ABBREVIATION', actor: ACTOR }),
      ).rejects.toThrow(SkillAliasConflictError);
    });

    // Alias type vocabulary is DB-enforced.
    it('enforces the alias_type vocabulary via a DB CHECK', async () => {
      const s = await service.createSkill({ canonicalName: 'Redis', actor: ACTOR });
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "skills_taxonomy"."SkillAlias"
             ("id","skill_id","alias","normalized_alias","alias_type")
           VALUES ('${uuidv7()}','${s.id}','Redis Cache','redis cache','BOGUS_TYPE')`,
        ),
      ).rejects.toThrow();
    });

    // Alias removal is a soft status flip and is audited; never a hard delete.
    it('soft-removes an alias (status flip, filtered from default listing, audited)', async () => {
      const s = await service.createSkill({ canonicalName: 'PostgreSQL', actor: ACTOR });
      const alias = await service.addAlias({
        skillId: s.id,
        alias: 'Postgres',
        aliasType: 'COMMON_NAME',
        actor: ACTOR,
      });
      await service.removeAlias(alias.id, ACTOR);
      expect((await service.listAliases(s.id)).length).toBe(0);
      expect((await service.listAliases(s.id, { includeInactive: true })).length).toBe(1);

      const events = (await skillRepo.listAuditEvents(s.id)).map((e) => e.event_type);
      expect(events).toEqual(['SKILL_CREATED', 'ALIAS_ADDED', 'ALIAS_REMOVED']);
    });

    // Version preservation — "Java 17" persists version 17; plain "Java" has none.
    it('records an explicit version and never infers one', async () => {
      const java = await service.createSkill({ canonicalName: 'Java', actor: ACTOR });
      // No inference: a freshly-created skill has ZERO versions.
      expect(await service.listVersions(java.id)).toEqual([]);

      const v17 = await service.addVersion({ skillId: java.id, version: '17', actor: ACTOR });
      expect(v17.version).toBe('17');
      expect(v17.normalized_version).toBe('17');
      expect((await service.listVersions(java.id)).map((v) => v.version)).toEqual(['17']);
      // Still exactly one — nothing inferred from adding the skill or the version.
      expect((await service.listVersions(java.id)).length).toBe(1);
    });

    // (skill_id, normalized_version) is unique; the same version on a different
    // skill is allowed.
    it('rejects a duplicate version per skill but allows the same version on another skill', async () => {
      const angular = await service.createSkill({ canonicalName: 'Angular', actor: ACTOR });
      const dotnet = await service.createSkill({ canonicalName: '.NET', actor: ACTOR });
      await service.addVersion({ skillId: angular.id, version: '17', actor: ACTOR });
      await expect(
        service.addVersion({ skillId: angular.id, version: '17', actor: ACTOR }),
      ).rejects.toThrow(SkillVersionConflictError);
      // Same normalized version, different skill — allowed.
      const other = await service.addVersion({ skillId: dotnet.id, version: '17', actor: ACTOR });
      expect(other.version).toBe('17');
    });

    // Alias/version audit events are recorded under the skill subject.
    it('audits VERSION_ADDED under the skill subject', async () => {
      const s = await service.createSkill({ canonicalName: 'Spring Boot', actor: ACTOR });
      await service.addVersion({ skillId: s.id, version: '3', actor: ACTOR });
      const events = (await skillRepo.listAuditEvents(s.id)).map((e) => e.event_type);
      expect(events).toEqual(['SKILL_CREATED', 'VERSION_ADDED']);
    });

    // Governance: alias/version on a missing skill is rejected.
    it('rejects alias/version for a non-existent skill', async () => {
      await expect(
        service.addAlias({ skillId: uuidv7(), alias: 'ZZ', aliasType: 'ABBREVIATION', actor: ACTOR }),
      ).rejects.toThrow(SkillNotFoundError);
      await expect(
        service.addVersion({ skillId: uuidv7(), version: '1', actor: ACTOR }),
      ).rejects.toThrow(SkillNotFoundError);
    });

    // No inference on lookup — an unknown alias surface form resolves to null.
    it('does not invent an alias mapping for an unknown surface form', async () => {
      expect(await service.findAliasBySurfaceForm('totally-unknown-alias')).toBeNull();
    });
  },
);
