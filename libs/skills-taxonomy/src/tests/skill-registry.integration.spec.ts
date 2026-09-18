import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SkillRepository } from '../lib/skill.repository.js';
import {
  SkillRegistryService,
  SkillConflictError,
  SkillNotFoundError,
} from '../lib/skill-registry.service.js';

// SKILL-TAX-1A canonical Skill registry — integration (real Postgres 17).
// Brings up a Postgres testcontainer, applies the init migration, and proves
// the 8 1A boundaries. Platform-global registry: no tenant_id anywhere.
//
// MIGRATIONS list:
//   - 20260915140000_init_skill_registry (Skill + SkillAuditEvent)
//   - 20260917210000_skill_tax_1f_governance (Skill.merged_into_skill_id — SKILL-TAX-1F-A;
//     the regenerated client SELECTs this column on every Skill read). Split-safe
//     (no dollar-quoted body); the audit-trigger migration is NOT applied here.
const MIGRATION_PATHS = [
  '20260915140000_init_skill_registry',
  '20260917210000_skill_tax_1f_governance',
  // SKILL-TAX-1F-B2 — updateSkill / deactivate / reactivate / merge now write a
  // SkillCorrectionTask atomically; its table is created here (regen client INSERTs it
  // → curated list must include it).
  '20260918120000_skill_tax_1f_b_governance_proposal_correction',
].map((n) => resolve(__dirname, `../../prisma/migrations/${n}/migration.sql`));

const ACTOR = { id: '55555555-5555-7555-8555-555555555555', type: 'platform_admin' };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SkillRegistryService — canonical registry integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let service: SkillRegistryService;
    let repo: SkillRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const path of MIGRATION_PATHS) {
        for (const stmt of readFileSync(path, 'utf8').split(';')) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.$executeRawUnsafe(trimmed);
        }
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new SkillRepository(prisma);
      service = new SkillRegistryService(repo);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    }, 60_000);

    // Boundary 1 — create persists, generates an opaque v7 id, computes the
    // normalized_name, defaults status to active.
    it('creates a canonical Skill with an opaque uuidv7 id and normalized lookup key', async () => {
      const skill = await service.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      expect(skill.canonical_name).toBe('Kubernetes');
      expect(skill.normalized_name).toBe('kubernetes');
      expect(skill.status).toBe('active');
      expect(skill.created_by).toBe(ACTOR.id);
      // Opaque uuidv7 (version nibble 7) — NOT the deterministic v5 skill_id.
      expect(skill.id[14]).toBe('7');
      const found = await service.getSkillById(skill.id);
      expect(found?.id).toBe(skill.id);
    });

    // Boundary 2 — normalized_name is the LOAD-BEARING uniqueness authority:
    // a capitalization variant collides on normalized_name, not canonical_name.
    it('rejects a normalized-name collision (Postgres != postgres) as the load-bearing key', async () => {
      await service.createSkill({ canonicalName: 'PostgreSQL', actor: ACTOR });
      const before = await service.resolveBySurfaceForm('postgresql');
      expect(before).not.toBeNull();

      let err: unknown;
      try {
        await service.createSkill({ canonicalName: 'postgresql', actor: ACTOR });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SkillConflictError);
      expect((err as SkillConflictError).constraint).toBe('normalized_name');

      // Exactly one row survived (the collision was rejected at the DB).
      const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM "skills_taxonomy"."Skill" WHERE "normalized_name" = 'postgresql'`,
      );
      expect(Number(rows[0].n)).toBe(1);
    });

    // Boundary 2b — exact-display duplicate collides on canonical_name.
    it('rejects an exact canonical_name duplicate', async () => {
      await service.createSkill({ canonicalName: 'Redis', actor: ACTOR });
      await expect(service.createSkill({ canonicalName: 'Redis', actor: ACTOR })).rejects.toThrow(
        SkillConflictError,
      );
    });

    // Boundary 3 — the status vocabulary is enforced at the DB by a CHECK.
    it('enforces the active|inactive lifecycle vocabulary via a DB CHECK', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "skills_taxonomy"."Skill" ("id","canonical_name","normalized_name","status")
           VALUES ('${uuidv7()}','BogusStatusSkill','bogusstatusskill','bogus')`,
        ),
      ).rejects.toThrow();
    });

    // Boundary 4 — lifecycle: deactivate hides from the default list; reactivate restores.
    it('deactivate/reactivate flips status and filters the default listing', async () => {
      const skill = await service.createSkill({ canonicalName: 'Terraform', actor: ACTOR });
      await service.deactivateSkill(skill.id, ACTOR);
      expect((await service.getSkillById(skill.id))?.status).toBe('inactive');

      const activeNames = (await service.listSkills()).map((s) => s.canonical_name);
      expect(activeNames).not.toContain('Terraform');
      const allNames = (await service.listSkills({ includeInactive: true })).map(
        (s) => s.canonical_name,
      );
      expect(allNames).toContain('Terraform');

      await service.reactivateSkill(skill.id, ACTOR);
      expect((await service.getSkillById(skill.id))?.status).toBe('active');
    });

    // Boundary 5 — a canonical rename never changes identity (opaque id).
    it('keeps the id stable across a canonical rename', async () => {
      const skill = await service.createSkill({ canonicalName: 'GoLang', actor: ACTOR });
      const renamed = await service.updateSkill(skill.id, { canonicalName: 'Go', actor: ACTOR });
      expect(renamed.id).toBe(skill.id);
      expect(renamed.canonical_name).toBe('Go');
      expect(renamed.normalized_name).toBe('go');
    });

    // Boundary 6 — audit: exact counts + event vocabulary for the 1A subset.
    it('emits exactly one audit event per mutation (created/updated/deactivated)', async () => {
      const skill = await service.createSkill({ canonicalName: 'Kafka', actor: ACTOR });
      expect(await repo.countAuditEvents(skill.id)).toBe(1);

      await service.updateSkill(skill.id, { description: 'event streaming', actor: ACTOR });
      await service.deactivateSkill(skill.id, ACTOR);
      expect(await repo.countAuditEvents(skill.id)).toBe(3);

      const events = await repo.listAuditEvents(skill.id);
      expect(events.map((e) => e.event_type)).toEqual([
        'SKILL_CREATED',
        'SKILL_UPDATED',
        'SKILL_DEACTIVATED',
      ]);
      expect(events[0].actor_id).toBe(ACTOR.id);
      expect(events[0].actor_type).toBe('platform_admin');
    });

    // Boundary 7 — platform-global: the Skill table has NO tenant_id column.
    it('is platform-global — Skill carries no tenant_id column', async () => {
      const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'skills_taxonomy' AND table_name = 'Skill'`,
      );
      const names = cols.map((c) => c.column_name);
      expect(names).toContain('normalized_name');
      expect(names).not.toContain('tenant_id');
    });

    // Boundary 8 — the audit event_type vocabulary is DB-enforced (full closed set).
    it('enforces the SkillAuditEvent event_type vocabulary via a DB CHECK', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "skills_taxonomy"."SkillAuditEvent"
             ("id","actor_type","event_type","subject_id","event_payload")
           VALUES ('${uuidv7()}','system','BOGUS_EVENT','${uuidv7()}','{}'::jsonb)`,
        ),
      ).rejects.toThrow();
    });

    // No-inference guard — the registry returns a Skill only for a normalized
    // match; an unknown/related surface form resolves to null (never invented).
    it('does not invent a match for an unknown surface form (no inference)', async () => {
      expect(await service.resolveBySurfaceForm('  KUBERNETES ')).not.toBeNull();
      expect(await service.resolveBySurfaceForm('some-unknown-tech-xyz')).toBeNull();
    });

    // Not-found translation.
    it('translates a missing-id mutation to SkillNotFoundError', async () => {
      await expect(service.deactivateSkill(uuidv7(), ACTOR)).rejects.toThrow(SkillNotFoundError);
    });
  },
);
