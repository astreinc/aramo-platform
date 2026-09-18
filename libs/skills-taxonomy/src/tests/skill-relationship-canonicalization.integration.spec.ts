import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SkillRepository } from '../lib/skill.repository.js';
import { SkillAliasRepository } from '../lib/skill-alias.repository.js';
import { SkillVersionRepository } from '../lib/skill-version.repository.js';
import { SkillRelationshipRepository } from '../lib/skill-relationship.repository.js';
import {
  SkillRegistryService,
  SkillRelationshipConflictError,
  SkillValidationError,
} from '../lib/skill-registry.service.js';
import { SkillCanonicalizationService } from '../lib/skill-canonicalization.service.js';

// SKILL-TAX-1C — SkillRelationship + deterministic canonicalization engine
// (real Postgres 17).
//
// MIGRATIONS list (applied in order):
//   - 20260915140000_init_skill_registry
//   - 20260915150000_skill_alias_version
//   - 20260915160000_skill_relationship
const MIGRATIONS = [
  resolve(__dirname, '../../prisma/migrations/20260915140000_init_skill_registry/migration.sql'),
  resolve(__dirname, '../../prisma/migrations/20260915150000_skill_alias_version/migration.sql'),
  resolve(__dirname, '../../prisma/migrations/20260915160000_skill_relationship/migration.sql'),
  // SKILL-TAX-1F-A — Skill.merged_into_skill_id (regen client SELECTs it). Split-safe.
  resolve(__dirname, '../../prisma/migrations/20260917210000_skill_tax_1f_governance/migration.sql'),
  // SKILL-TAX-1F-B2 — governance mutations now write a SkillCorrectionTask atomically;
  // its table is created here (regen client INSERTs it → curated list must include it).
  resolve(__dirname, '../../prisma/migrations/20260918120000_skill_tax_1f_b_governance_proposal_correction/migration.sql'),
];

const ACTOR = { id: '55555555-5555-7555-8555-555555555555', type: 'platform_admin' };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SkillRelationship + canonicalization engine integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let service: SkillRegistryService;
    let engine: SkillCanonicalizationService;
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
      const aliasRepo = new SkillAliasRepository(prisma);
      const versionRepo = new SkillVersionRepository(prisma);
      service = new SkillRegistryService(
        skillRepo,
        aliasRepo,
        versionRepo,
        new SkillRelationshipRepository(prisma),
      );
      engine = new SkillCanonicalizationService(skillRepo, aliasRepo, versionRepo);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    }, 60_000);

    // --- Relationships ----------------------------------------------------

    // Symmetric edge stored once; visible from either skill; deduped on re-add.
    it('stores a symmetric RELATED_TO edge once and dedupes the reverse', async () => {
      const k8s = await service.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      const docker = await service.createSkill({ canonicalName: 'Docker', actor: ACTOR });
      const rel = await service.addRelationship({
        sourceSkillId: k8s.id,
        targetSkillId: docker.id,
        relationshipType: 'RELATED_TO',
        source: 'ADMIN_CURATED',
        actor: ACTOR,
      });
      expect(rel.directionality).toBe('SYMMETRIC');
      expect((await service.listRelationships(k8s.id)).length).toBe(1);
      expect((await service.listRelationships(docker.id)).length).toBe(1);

      // Reverse orientation is the same canonical edge -> conflict.
      await expect(
        service.addRelationship({
          sourceSkillId: docker.id,
          targetSkillId: k8s.id,
          relationshipType: 'RELATED_TO',
          source: 'ADMIN_CURATED',
          actor: ACTOR,
        }),
      ).rejects.toThrow(SkillRelationshipConflictError);
    });

    // Directed edges: PARENT_OF(A,B) and PARENT_OF(B,A) are distinct.
    it('treats a directed relationship as orientation-specific', async () => {
      const rel = await service.createSkill({ canonicalName: 'Relational Database', actor: ACTOR });
      const pg = await service.createSkill({ canonicalName: 'PostgreSQL', actor: ACTOR });
      const edge = await service.addRelationship({
        sourceSkillId: rel.id,
        targetSkillId: pg.id,
        relationshipType: 'PARENT_OF',
        source: 'ADMIN_CURATED',
        actor: ACTOR,
      });
      expect(edge.directionality).toBe('DIRECTED');
      // Opposite orientation is a different edge — allowed.
      const reverse = await service.addRelationship({
        sourceSkillId: pg.id,
        targetSkillId: rel.id,
        relationshipType: 'PARENT_OF',
        source: 'ADMIN_CURATED',
        actor: ACTOR,
      });
      expect(reverse.id).not.toBe(edge.id);
    });

    it('rejects a self-relationship', async () => {
      const s = await service.createSkill({ canonicalName: 'Helm', actor: ACTOR });
      await expect(
        service.addRelationship({
          sourceSkillId: s.id,
          targetSkillId: s.id,
          relationshipType: 'RELATED_TO',
          source: 'ADMIN_CURATED',
          actor: ACTOR,
        }),
      ).rejects.toThrow(SkillValidationError);
    });

    it('enforces the relationship_type + source vocabularies via DB CHECKs', async () => {
      const a = await service.createSkill({ canonicalName: 'Kafka', actor: ACTOR });
      const b = await service.createSkill({ canonicalName: 'RabbitMQ', actor: ACTOR });
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "skills_taxonomy"."SkillRelationship"
             ("id","source_skill_id","target_skill_id","relationship_type","directionality","source")
           VALUES ('${uuidv7()}','${a.id}','${b.id}','BOGUS_TYPE','DIRECTED','ADMIN_CURATED')`,
        ),
      ).rejects.toThrow();
    });

    it('audits RELATIONSHIP_ADDED under the source skill subject', async () => {
      const a = await service.createSkill({ canonicalName: 'gRPC', actor: ACTOR });
      const b = await service.createSkill({ canonicalName: 'Protocol Buffers', actor: ACTOR });
      await service.addRelationship({
        sourceSkillId: a.id,
        targetSkillId: b.id,
        relationshipType: 'BUILT_ON',
        source: 'VENDOR_DOC',
        actor: ACTOR,
      });
      const events = (await skillRepo.listAuditEvents(a.id)).map((e) => e.event_type);
      expect(events).toEqual(['SKILL_CREATED', 'RELATIONSHIP_ADDED']);
    });

    // §10 — relationships NEVER become Talent evidence. Taxonomy knows Docker is
    // related to Kubernetes, but canonicalizing "kubernetes" resolves to
    // Kubernetes ONLY (Docker is never implied as evidence).
    it('keeps relationship availability separate from evidence (no Talent claim)', async () => {
      const kResolved = await engine.resolve({ surfaceForm: 'kubernetes' });
      expect(kResolved.status).toBe('RESOLVED');
      expect(kResolved.canonicalName).toBe('Kubernetes');
      const related = await service.listRelationships(kResolved.canonicalSkillId as string);
      // The Docker edge exists as taxonomy...
      expect(related.length).toBeGreaterThanOrEqual(1);
      // ...but resolving Kubernetes never yields Docker's identity.
      const dockerBy = await engine.resolve({ surfaceForm: 'docker' });
      expect(kResolved.canonicalSkillId).not.toBe(dockerBy.canonicalSkillId);
    });

    // --- Canonicalization engine -----------------------------------------

    it('resolves EXACT_CANONICAL and preserves the surface form verbatim', async () => {
      await service.createSkill({ canonicalName: 'Terraform', actor: ACTOR });
      const r = await engine.resolve({ surfaceForm: '  TERRAFORM ' });
      expect(r.status).toBe('RESOLVED');
      expect(r.matchMethod).toBe('EXACT_CANONICAL');
      expect(r.canonicalName).toBe('Terraform');
      expect(r.surfaceForm).toBe('  TERRAFORM '); // never rewritten
    });

    it('resolves via ALIAS to the canonical skill', async () => {
      const spring = await service.createSkill({ canonicalName: 'Spring Boot', actor: ACTOR });
      await service.addAlias({
        skillId: spring.id,
        alias: 'SpringBoot',
        aliasType: 'SPELLING_VARIANT',
        actor: ACTOR,
      });
      const r = await engine.resolve({ surfaceForm: 'springboot' });
      expect(r.status).toBe('RESOLVED');
      expect(r.matchMethod).toBe('ALIAS');
      expect(r.canonicalSkillId).toBe(spring.id);
    });

    it('resolves an explicit version only when the skill actually has it', async () => {
      const java = await service.createSkill({ canonicalName: 'Java', actor: ACTOR });
      await service.addVersion({ skillId: java.id, version: '17', actor: ACTOR });

      const withV = await engine.resolve({ surfaceForm: 'Java', explicitVersion: '17' });
      expect(withV.matchMethod).toBe('VERSION');
      expect(withV.canonicalVersionId).not.toBeNull();

      // Version stated but not in the registry -> skill resolves, version does not,
      // and nothing is inferred.
      const missingV = await engine.resolve({ surfaceForm: 'Java', explicitVersion: '11' });
      expect(missingV.status).toBe('RESOLVED');
      expect(missingV.canonicalSkillId).toBe(java.id);
      expect(missingV.canonicalVersionId).toBeNull();
      expect(missingV.versionSurface).toBe('11');
    });

    it('returns UNRESOLVED for an unknown surface form (no inference)', async () => {
      const r = await engine.resolve({ surfaceForm: 'totally-unknown-skill-xyz' });
      expect(r.status).toBe('UNRESOLVED');
      expect(r.canonicalSkillId).toBeNull();
      expect(r.matchMethod).toBeNull();
    });
  },
);
