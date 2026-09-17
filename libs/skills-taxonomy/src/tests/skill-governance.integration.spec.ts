import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SkillRepository } from '../lib/skill.repository.js';
import { SkillAliasRepository } from '../lib/skill-alias.repository.js';
import { SkillVersionRepository } from '../lib/skill-version.repository.js';
import { SkillRelationshipRepository } from '../lib/skill-relationship.repository.js';
import { SkillRegistryService, SkillNotFoundError, SkillValidationError } from '../lib/skill-registry.service.js';

// SKILL-TAX-1F governance — real Postgres 17. Proves the two novel foundation
// invariants: (1) SkillAuditEvent is an APPEND-ONLY ledger enforced at the DB
// (UPDATE + DELETE rejected by trigger); (2) SOFT merge keeps the loser id, sets
// status='inactive' + merged_into_skill_id, and emits SKILL_MERGED — the loser is
// never hard-deleted. Migrations applied WHOLE via pg (the 1F migration carries a
// `$$`-quoted trigger body that a naive `;` split would corrupt).
const MIGRATIONS = [
  '20260915140000_init_skill_registry',
  '20260915150000_skill_alias_version',
  '20260915160000_skill_relationship',
  '20260917210000_skill_tax_1f_governance',
  '20260917211000_skill_tax_1f_audit_append_only',
].map((n) => resolve(__dirname, `../../prisma/migrations/${n}/migration.sql`));

const ACTOR = { id: '55555555-5555-7555-8555-555555555555', type: 'platform_admin' };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SKILL-TAX-1F governance — merge + append-only audit (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let service: SkillRegistryService;
    let repo: SkillRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await db.end();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new SkillRepository(prisma);
      service = new SkillRegistryService(
        repo,
        new SkillAliasRepository(prisma),
        new SkillVersionRepository(prisma),
        new SkillRelationshipRepository(prisma),
      );
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    }, 60_000);

    it('SOFT merge: loser keeps id, goes inactive + merged_into winner, emits SKILL_MERGED', async () => {
      const winner = await service.createSkill({ canonicalName: 'Kubernetes', actor: ACTOR });
      const loser = await service.createSkill({ canonicalName: 'Kube', actor: ACTOR });

      const merged = await service.mergeSkill(loser.id, winner.id, ACTOR);
      expect(merged.id).toBe(loser.id); // permanently addressable — never re-keyed
      expect(merged.status).toBe('inactive');
      expect(merged.merged_into_skill_id).toBe(winner.id);

      // Loser row still present (not hard-deleted); winner untouched.
      expect((await service.getSkillById(loser.id))?.merged_into_skill_id).toBe(winner.id);
      expect((await service.getSkillById(winner.id))?.status).toBe('active');

      const events = await repo.listAuditEvents(loser.id);
      expect(events.map((e) => e.event_type)).toContain('SKILL_MERGED');
    });

    it('rejects self-merge, unknown ids, and a non-active winner', async () => {
      const a = await service.createSkill({ canonicalName: 'Redis', actor: ACTOR });
      await expect(service.mergeSkill(a.id, a.id, ACTOR)).rejects.toBeInstanceOf(SkillValidationError);
      await expect(
        service.mergeSkill(a.id, '00000000-0000-7000-8000-0000000000ff', ACTOR),
      ).rejects.toBeInstanceOf(SkillNotFoundError);
      // winner already merged away → not a valid target.
      const winner = await service.createSkill({ canonicalName: 'Postgres', actor: ACTOR });
      const gone = await service.createSkill({ canonicalName: 'PG', actor: ACTOR });
      await service.mergeSkill(gone.id, winner.id, ACTOR);
      await expect(service.mergeSkill(a.id, gone.id, ACTOR)).rejects.toBeInstanceOf(SkillValidationError);
    });

    it('records CANONICALIZATION_OVERRIDDEN as an audit-only correction event', async () => {
      const s = await service.createSkill({ canonicalName: 'Golang', actor: ACTOR });
      await service.recordCanonicalizationOverride({
        subjectId: s.id,
        actor: ACTOR,
        payload: { decision: 'map_surface', surface_form: 'go' },
      });
      const events = await repo.listAuditEvents(s.id);
      expect(events.map((e) => e.event_type)).toContain('CANONICALIZATION_OVERRIDDEN');
    });

    it('SkillAuditEvent is APPEND-ONLY at the DB — UPDATE and DELETE are rejected', async () => {
      const s = await service.createSkill({ canonicalName: 'Rust', actor: ACTOR });
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "skills_taxonomy"."SkillAuditEvent" SET "actor_type" = 'x'`),
      ).rejects.toThrow(/append-only/i);
      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM "skills_taxonomy"."SkillAuditEvent" WHERE "subject_id" = '${s.id}'::uuid`,
        ),
      ).rejects.toThrow(/append-only/i);
    });
  },
);
