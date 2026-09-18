import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SkillRepository } from '../lib/skill.repository.js';
import { SkillAliasRepository } from '../lib/skill-alias.repository.js';
import { SkillRelationshipRepository } from '../lib/skill-relationship.repository.js';
import { SkillGovernanceProposalRepository } from '../lib/skill-governance-proposal.repository.js';
import {
  SkillGovernanceService,
  ProposalNotFoundError,
  ProposalNotPendingError,
  ProposalPayloadError,
} from '../lib/skill-governance.service.js';

// SKILL-TAX-1F-B2 — the AI proposal ratification service against a real Postgres 17.
// Proves the ratified invariants: (1) accept is ONE atomic taxonomy transaction that
// REUSES the canonical registry write primitive (an accepted ALIAS proposal produces
// the SAME alias row + ALIAS_ADDED audit + ALIAS_CORRECTION durable task as a direct
// addAlias) and marks the proposal ACCEPTED + applied_entity_id; (2) an accepted
// RELATIONSHIP proposal writes the edge + audit but emits NO correction task
// (taxonomy intelligence never alters canonical identity); (3) accept/reject are
// terminal-once — a non-PENDING proposal is refused and mutates nothing.
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
  'SKILL-TAX-1F-B2 governance proposals — accept/reject (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let service: SkillGovernanceService;
    let proposals: SkillGovernanceProposalRepository;
    let skills: SkillRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await db.end();

      prisma = new PrismaService(url);
      await prisma.$connect();
      skills = new SkillRepository(prisma);
      proposals = new SkillGovernanceProposalRepository(prisma);
      service = new SkillGovernanceService(
        prisma,
        proposals,
        new SkillAliasRepository(prisma),
        new SkillRelationshipRepository(prisma),
      );
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    }, 60_000);

    beforeEach(async () => {
      // TRUNCATE bypasses the SkillAuditEvent BEFORE-DELETE append-only trigger.
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE skills_taxonomy."SkillAuditEvent", skills_taxonomy."SkillCorrectionTask", skills_taxonomy."SkillRelationship", skills_taxonomy."SkillVersion", skills_taxonomy."SkillAlias", skills_taxonomy."SkillGovernanceProposal", skills_taxonomy."Skill" CASCADE',
      );
    });

    async function seedSkill(canonical: string, normalized: string): Promise<string> {
      const row = await skills.createSkill({
        canonical_name: canonical,
        normalized_name: normalized,
        description: null,
        actor: ACTOR,
      });
      return row.id;
    }

    it('accept ALIAS proposal: reuses the registry primitive (alias + ALIAS_ADDED audit + ALIAS_CORRECTION), marks ACCEPTED atomically', async () => {
      const skillId = await seedSkill('Kubernetes', 'kubernetes');
      const created = await service.createProposal({
        proposal_type: 'ALIAS',
        source: 'AI_RECOMMENDED',
        payload: { skill_id: skillId, alias: 'K8s', alias_type: 'ABBREVIATION' },
        proposed_by: null,
      });
      expect(created.status).toBe('PENDING');

      const accepted = await service.accept(created.id, ACTOR);

      expect(accepted.status).toBe('ACCEPTED');
      expect(accepted.decided_by).toBe(ACTOR.id);
      expect(accepted.applied_entity_id).not.toBeNull();

      // The canonical write happened via addAliasWithin — same alias row a direct add
      // would produce (active, normalized), keyed to applied_entity_id.
      const aliasRows = await prisma.$queryRawUnsafe<Array<{ id: string; alias: string; normalized_alias: string; status: string; skill_id: string }>>(
        'SELECT id, alias, normalized_alias, status, skill_id FROM skills_taxonomy."SkillAlias"',
      );
      expect(aliasRows).toHaveLength(1);
      expect(aliasRows[0]!.id).toBe(accepted.applied_entity_id);
      expect(aliasRows[0]!.alias).toBe('K8s');
      expect(aliasRows[0]!.normalized_alias).toBe('k8s');
      expect(aliasRows[0]!.status).toBe('active');
      expect(aliasRows[0]!.skill_id).toBe(skillId);

      // The ALIAS_ADDED audit + ALIAS_CORRECTION durable task were written in the SAME
      // transaction (durable re-reconcile record; surface-keyed, no repoint).
      const audit = await prisma.$queryRawUnsafe<Array<{ event_type: string }>>(
        `SELECT event_type FROM skills_taxonomy."SkillAuditEvent" WHERE event_type = 'ALIAS_ADDED'`,
      );
      expect(audit).toHaveLength(1);
      const tasks = await prisma.$queryRawUnsafe<Array<{ correction_type: string; surface_form: string | null; from_canonical_skill_id: string | null; to_canonical_skill_id: string | null; status: string }>>(
        'SELECT correction_type, surface_form, from_canonical_skill_id, to_canonical_skill_id, status FROM skills_taxonomy."SkillCorrectionTask"',
      );
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.correction_type).toBe('ALIAS_CORRECTION');
      expect(tasks[0]!.surface_form).toBe('K8s');
      expect(tasks[0]!.from_canonical_skill_id).toBeNull();
      expect(tasks[0]!.to_canonical_skill_id).toBeNull();
      expect(tasks[0]!.status).toBe('PENDING');
    });

    it('accept RELATIONSHIP proposal: writes the edge + RELATIONSHIP_ADDED audit but NO correction task', async () => {
      const a = await seedSkill('React', 'react');
      const b = await seedSkill('JavaScript', 'javascript');
      const created = await service.createProposal({
        proposal_type: 'RELATIONSHIP',
        source: 'AI_RECOMMENDED',
        payload: {
          source_skill_id: a,
          target_skill_id: b,
          relationship_type: 'BUILT_ON',
          source: 'ADMIN_CURATED',
        },
        proposed_by: null,
      });

      const accepted = await service.accept(created.id, ACTOR);
      expect(accepted.status).toBe('ACCEPTED');
      expect(accepted.applied_entity_id).not.toBeNull();

      const rels = await prisma.$queryRawUnsafe<Array<{ id: string; relationship_type: string; directionality: string; status: string }>>(
        'SELECT id, relationship_type, directionality, status FROM skills_taxonomy."SkillRelationship"',
      );
      expect(rels).toHaveLength(1);
      expect(rels[0]!.id).toBe(accepted.applied_entity_id);
      expect(rels[0]!.relationship_type).toBe('BUILT_ON');
      expect(rels[0]!.directionality).toBe('DIRECTED');

      const tasks = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM skills_taxonomy."SkillCorrectionTask"',
      );
      expect(tasks).toHaveLength(0);
    });

    it('accept a non-PENDING proposal is refused (terminal-once) and mutates nothing further', async () => {
      const skillId = await seedSkill('Kubernetes', 'kubernetes');
      const created = await service.createProposal({
        proposal_type: 'ALIAS',
        source: 'AI_RECOMMENDED',
        payload: { skill_id: skillId, alias: 'K8s', alias_type: 'ABBREVIATION' },
        proposed_by: null,
      });
      await service.accept(created.id, ACTOR);

      await expect(service.accept(created.id, ACTOR)).rejects.toBeInstanceOf(ProposalNotPendingError);

      // Still exactly one alias — the refused second accept created nothing.
      const aliasRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM skills_taxonomy."SkillAlias"',
      );
      expect(aliasRows).toHaveLength(1);
    });

    it('accept a missing proposal throws ProposalNotFoundError', async () => {
      await expect(service.accept(uuidv7(), ACTOR)).rejects.toBeInstanceOf(ProposalNotFoundError);
    });

    it('accept an ALIAS proposal with an invalid payload is refused and stays PENDING (no alias written)', async () => {
      const created = await service.createProposal({
        proposal_type: 'ALIAS',
        source: 'AI_RECOMMENDED',
        payload: { alias_type: 'ABBREVIATION' }, // missing skill_id + alias
        proposed_by: null,
      });

      await expect(service.accept(created.id, ACTOR)).rejects.toBeInstanceOf(ProposalPayloadError);

      const reread = await proposals.findById(created.id);
      expect(reread?.status).toBe('PENDING');
      const aliasRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM skills_taxonomy."SkillAlias"',
      );
      expect(aliasRows).toHaveLength(0);
    });

    it('reject a PENDING proposal transitions it to REJECTED; a second reject is refused', async () => {
      const skillId = await seedSkill('Kubernetes', 'kubernetes');
      const created = await service.createProposal({
        proposal_type: 'ALIAS',
        source: 'AI_RECOMMENDED',
        payload: { skill_id: skillId, alias: 'K8s', alias_type: 'ABBREVIATION' },
        proposed_by: null,
      });

      const rejected = await service.reject(created.id, 'duplicate of an existing alias', ACTOR);
      expect(rejected.status).toBe('REJECTED');
      expect(rejected.decided_by).toBe(ACTOR.id);
      expect(rejected.decision_reason).toBe('duplicate of an existing alias');

      await expect(service.reject(created.id, null, ACTOR)).rejects.toBeInstanceOf(ProposalNotPendingError);
      // A rejected proposal never produced a canonical alias.
      const aliasRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM skills_taxonomy."SkillAlias"',
      );
      expect(aliasRows).toHaveLength(0);
    });
  },
);
