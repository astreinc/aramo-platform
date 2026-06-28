import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentTrustRepository } from '../lib/talent-trust.repository.js';
import { TalentTrustService, type SubjectRef } from '../lib/talent-trust.service.js';

// TR-1 integration test — brings up a Postgres 17 testcontainer, applies the
// init migration, and proves the DoD against real SQL:
//   - recordEvidence resolves-or-creates the subject, appends EvidenceRecord +
//     CREATED event, and materializes TrustState;
//   - the four bands recompute on every write (SELF-only → SELF_ASSERTED;
//     authoritative → AUTHORITATIVE);
//   - an open contradiction caps the dimension + raises the flag, with a
//     first-class EvidenceLink CONTRADICTS row;
//   - supersession retains history (old → SUPERSEDED, new VALID, SUPERSEDES link);
//   - EvidenceRecord assertion content is immutable (DB trigger) while
//     current_status remains mutable; EvidenceEvent is append-only;
//   - merge/unmerge is reversible and getTrustState follows the merge pointer.

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260628000000_init_talent_trust/migration.sql',
);

const TENANT = '11111111-1111-7111-8111-111111111111';
const REF_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REF_B = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

const subjectRefA: SubjectRef = {
  tenant_id: TENANT,
  ref_type: 'ATS_TALENT_RECORD',
  ref_id: REF_A,
  link_source: 'tr-1-integration',
};
const subjectRefB: SubjectRef = {
  tenant_id: TENANT,
  ref_type: 'PERSON_CLUSTER',
  ref_id: REF_B,
  link_source: 'tr-1-integration',
};

// $$-aware DDL splitter (the migration's trigger function bodies contain
// semicolons inside $$ … $$). Mirrors libs/consent's integration harness.
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

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TalentTrustService — ledger + rollup integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TalentTrustRepository;
    let service: TalentTrustService;

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
      repo = new TalentTrustRepository(prisma);
      service = new TalentTrustService(repo);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('recordEvidence resolves-or-creates a subject, appends a CREATED event, and materializes TrustState (SELF → SELF_ASSERTED)', async () => {
      const ev = await service.recordEvidence({
        subjectRef: subjectRefA,
        dimension: 'CLAIMS',
        assertion_type: 'SKILL',
        assertion_payload: { skill: 'TypeScript', years: 7 },
        source_class: 'SELF',
        method: 'SELF_DECLARED',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'MODERATE',
        created_by: 'tr-2-skill-collector',
      });

      expect(ev.current_status).toBe('VALID');
      expect(ev.strength).toBeCloseTo(0.05, 5);
      expect(ev.ai_derived).toBe(false);

      const state = await service.getTrustState(subjectRefA);
      expect(state?.claims_band).toBe('SELF_ASSERTED');
      expect(state?.identity_band).toBe('NOT_ESTABLISHED');

      // A second write against the SAME ref reuses the subject (resolve-or-create).
      const ev2 = await service.recordEvidence({
        subjectRef: subjectRefA,
        dimension: 'IDENTITY',
        assertion_type: 'IDENTITY_DOCUMENT',
        assertion_payload: { doc: 'passport' },
        source_class: 'AUTHORITATIVE_ISSUER',
        method: 'API_REGISTRY',
        source_ref: { issuer: 'US-DOS' },
        portability_class: 'ATTESTATION_PORTABLE',
        decay_profile: 'DURABLE',
        ai_derived: true,
        created_by: 'tr-3-identity',
      });
      expect(ev2.subject_id).toBe(ev.subject_id);
      expect(ev2.ai_derived).toBe(true);

      const state2 = await service.getTrustState(subjectRefA);
      expect(state2?.identity_band).toBe('AUTHORITATIVE');
      expect(state2?.claims_band).toBe('SELF_ASSERTED');
    });

    it('contradiction caps the dimension at CORROBORATED, raises the count, and writes a CONTRADICTS link', async () => {
      const authoritative = await service.recordEvidence({
        subjectRef: subjectRefA,
        dimension: 'ELIGIBILITY',
        assertion_type: 'RIGHT_TO_WORK',
        assertion_payload: { status: 'authorized' },
        source_class: 'AUTHORITATIVE_ISSUER',
        method: 'DOCUMENT',
        source_ref: { issuer: 'USCIS' },
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: 'tr-9-eligibility',
      });
      const contradicting = await service.recordEvidence({
        subjectRef: subjectRefA,
        dimension: 'ELIGIBILITY',
        assertion_type: 'RIGHT_TO_WORK',
        assertion_payload: { status: 'not_authorized' },
        source_class: 'THIRD_PARTY_VERIFIED',
        method: 'DOCUMENT',
        source_ref: { issuer: 'background-vendor' },
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: 'tr-9-eligibility',
      });

      // Before contradiction: authoritative document → INDEPENDENTLY_VERIFIED.
      const pre = await service.getTrustState(subjectRefA);
      expect(pre?.eligibility_band).toBe('INDEPENDENTLY_VERIFIED');

      await service.contradict(authoritative.id, contradicting.id, 'registry vs vendor conflict');

      const post = await service.getTrustState(subjectRefA);
      expect(post?.eligibility_band).toBe('CORROBORATED'); // capped
      expect(post?.open_contradiction_count).toBe(1);

      const links = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM talent_trust."EvidenceLink" WHERE relation = 'CONTRADICTS' AND to_evidence_id = $1`,
        authoritative.id,
      );
      expect(Number(links[0].count)).toBe(1);

      const contradicted = await repo.findEvidenceById(authoritative.id);
      expect(contradicted?.current_status).toBe('CONTRADICTED');
    });

    it('supersession retains history: old → SUPERSEDED, new VALID, SUPERSEDES link present', async () => {
      const oldEv = await service.recordEvidence({
        subjectRef: subjectRefA,
        dimension: 'CONTINUITY',
        assertion_type: 'EMPLOYMENT',
        assertion_payload: { employer: 'Acme', current: true },
        source_class: 'THIRD_PARTY_VERIFIED',
        method: 'DOCUMENT',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'FAST',
        created_by: 'tr-7-continuity',
      });
      const newEv = await service.recordEvidence({
        subjectRef: subjectRefA,
        dimension: 'CONTINUITY',
        assertion_type: 'EMPLOYMENT',
        assertion_payload: { employer: 'Acme', current: true, refreshed: true },
        source_class: 'AUTHORITATIVE_ISSUER',
        method: 'API_REGISTRY',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'FAST',
        created_by: 'tr-7-continuity',
      });

      await service.supersede(oldEv.id, newEv.id);

      const oldRow = await repo.findEvidenceById(oldEv.id);
      const newRow = await repo.findEvidenceById(newEv.id);
      expect(oldRow?.current_status).toBe('SUPERSEDED'); // retained, not deleted
      expect(newRow?.current_status).toBe('VALID');

      const links = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM talent_trust."EvidenceLink" WHERE relation = 'SUPERSEDES' AND from_evidence_id = $1 AND to_evidence_id = $2`,
        newEv.id,
        oldEv.id,
      );
      expect(Number(links[0].count)).toBe(1);
    });

    it('markStale / revoke / dispute / resolveDispute drive current_status and the rollup flags', async () => {
      const ev = await service.recordEvidence({
        subjectRef: subjectRefB,
        dimension: 'CLAIMS',
        assertion_type: 'CERTIFICATION',
        assertion_payload: { cert: 'AWS-SAA' },
        source_class: 'AUTHORITATIVE_ISSUER',
        method: 'API_REGISTRY',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'MODERATE',
        created_by: 'tr-8-cert',
      });

      await service.dispute(ev.id, 'talent disputes expiry date');
      let state = await service.getTrustState(subjectRefB);
      expect(state?.has_open_dispute).toBe(true);
      expect(state?.claims_band).toBe('NOT_ESTABLISHED'); // disputed → non-contributing

      await service.resolveDispute(ev.id, 'upheld');
      state = await service.getTrustState(subjectRefB);
      expect(state?.has_open_dispute).toBe(false);
      // Back to VALID — AUTHORITATIVE_ISSUER via API_REGISTRY is an authoritative source.
      expect(state?.claims_band).toBe('AUTHORITATIVE');

      await service.markStale(ev.id);
      state = await service.getTrustState(subjectRefB);
      expect(state?.stale_evidence_count).toBe(1);

      await service.revoke(ev.id, 'cert revoked by issuer');
      const revoked = await repo.findEvidenceById(ev.id);
      expect(revoked?.current_status).toBe('REVOKED');
    });

    it('EvidenceRecord assertion content is immutable (DB trigger); current_status remains mutable', async () => {
      const ev = await service.recordEvidence({
        subjectRef: subjectRefB,
        dimension: 'IDENTITY',
        assertion_type: 'FACE_MATCH',
        assertion_payload: { score: 0.99 },
        source_class: 'BIOMETRIC',
        method: 'BIOMETRIC',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'PER_STEP',
        created_by: 'tr-4-biometric',
      });

      // Mutating assertion content directly is rejected by the trigger.
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE talent_trust."EvidenceRecord" SET source_class = 'SELF' WHERE id = $1`,
          ev.id,
        ),
      ).rejects.toThrow(/immutable/i);

      // Updating only current_status is permitted (the lifecycle path).
      await expect(repo.updateEvidenceStatus(ev.id, 'STALE')).resolves.toBeTruthy();
    });

    it('EvidenceEvent is append-only (UPDATE rejected by trigger)', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE talent_trust."EvidenceEvent" SET reason = 'tampered' WHERE tenant_id = $1`,
          TENANT,
        ),
      ).rejects.toThrow(/append-only/i);
    });

    it('merge is reversible and getTrustState follows the merge pointer (R6 capability)', async () => {
      const stateA = await service.getTrustState(subjectRefA);
      const stateB = await service.getTrustState(subjectRefB);
      if (stateA === null || stateB === null) throw new Error('expected both subjects to exist');
      const subjectAId = stateA.subject_id;
      const subjectBId = stateB.subject_id;
      expect(subjectAId).not.toBe(subjectBId);

      await service.mergeSubjects(subjectAId, subjectBId, 'same human, TR-6 trial');

      // Reading B's ref now returns A's materialized state (the surviving subject).
      const merged = await service.getTrustState(subjectRefB);
      expect(merged?.subject_id).toBe(subjectAId);

      // Unmerge restores B to its own state (mark-never-delete, reversible).
      await service.unmergeSubjects(subjectBId, 'rollback trial');
      const restored = await service.getTrustState(subjectRefB);
      expect(restored?.subject_id).toBe(subjectBId);
    });

    it('getEvidence returns the ledger for a subject, filterable by dimension', async () => {
      const all = await service.getEvidence(subjectRefA);
      expect(all.length).toBeGreaterThan(0);
      const eligibility = await service.getEvidence(subjectRefA, { dimension: 'ELIGIBILITY' });
      expect(eligibility.every((e) => e.dimension === 'ELIGIBILITY')).toBe(true);
    });
  },
);
