import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentTrustRepository } from '../lib/talent-trust.repository.js';
import { SubjectMatcherService } from '../lib/subject-matcher.service.js';
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
// Slice-B1 — the regenerated client SELECTs ResolutionSubject.last_reconciled_at
// + reconcile_attempts on every subject read, so the columns must exist.
const WATERMARK_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
);
// TR-6 B1 — last_matched_at (client SELECTs it) + the SubjectMergeOperation table
// and its kind/actor/reason columns (mergeSubjects/unmergeSubjects now persist a row).
const TR6_B1_MIGRATION_PATHS = [
  '../../prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
  '../../prisma/migrations/20260706230000_tr2a_b3b_subject_merge_operation/migration.sql',
  '../../prisma/migrations/20260707130000_tr6_b1_merge_operation_kind/migration.sql',
].map((p) => resolve(__dirname, p));
// Promotion-Trigger slice-A — the partial-unique (≤1 ATS_TALENT_RECORD ref per
// subject); this spec's race-guard test relies on it existing.
const ATS_REF_UNIQUE_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260706120000_ats_ref_partial_unique/migration.sql',
);
// TR-4 B1 — EvidenceLink @@unique([from,to,relation]); contradict/supersede below
// now existence-check first (repeat = no-op) and the DB rejects any stray dup.
const LINK_UNIQUE_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260709120000_tr4_b1_evidence_link_unique/migration.sql',
);
// TR-4 B3 — last_consistency_at watermark (the regenerated client SELECTs it on
// every ResolutionSubject read below).
const CONSISTENCY_WATERMARK_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260710120000_tr4_b3_last_consistency_at/migration.sql',
);
// TR-5 B2 — TrustState thinness flags (the regenerated client SELECTs them).
const THINNESS_FLAGS_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260711120000_tr5_b2_thinness_flags/migration.sql',
);

const TENANT = '11111111-1111-7111-8111-111111111111';
const REF_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REF_B = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const REF_C = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

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
const subjectRefC: SubjectRef = {
  tenant_id: TENANT,
  ref_type: 'ATS_TALENT_RECORD',
  ref_id: REF_C,
  link_source: 'cold-ingest-extraction-integration',
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
      const watermarkSql = readFileSync(WATERMARK_MIGRATION_PATH, 'utf8');
      const atsRefUniqueSql = readFileSync(ATS_REF_UNIQUE_MIGRATION_PATH, 'utf8');
      const tr6Sqls = TR6_B1_MIGRATION_PATHS.map((p) => readFileSync(p, 'utf8'));
      const linkUniqueSql = readFileSync(LINK_UNIQUE_MIGRATION_PATH, 'utf8');
      const consistencyWatermarkSql = readFileSync(CONSISTENCY_WATERMARK_MIGRATION_PATH, 'utf8');
      const thinnessFlagsSql = readFileSync(THINNESS_FLAGS_MIGRATION_PATH, 'utf8');
      for (const sql of [migrationSql, watermarkSql, atsRefUniqueSql, ...tr6Sqls, linkUniqueSql, consistencyWatermarkSql, thinnessFlagsSql]) {
        for (const stmt of splitDdl(sql)) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.$executeRawUnsafe(trimmed);
        }
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new TalentTrustRepository(prisma);
      service = new TalentTrustService(repo, new SubjectMatcherService(repo));
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
        // TR-4 B1 — SKILL is now a registered canonical shape ({value_raw}).
        assertion_payload: { value_raw: 'TypeScript' },
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
        // TR-4 B1 — EMPLOYMENT is now a registered canonical shape.
        assertion_payload: { employer_raw: 'Acme', role_title_raw: 'Engineer' },
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
        assertion_payload: { employer_raw: 'Acme', role_title_raw: 'Senior Engineer' },
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
        assertion_payload: { match_confidence: 0.99 },
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

      await service.mergeSubjects(subjectAId, subjectBId, 'same human, TR-6 trial', 'test-actor');

      // Reading B's ref now returns A's materialized state (the surviving subject).
      const merged = await service.getTrustState(subjectRefB);
      expect(merged?.subject_id).toBe(subjectAId);

      // Unmerge restores B to its own state (mark-never-delete, reversible).
      await service.unmergeSubjects(subjectBId, 'rollback trial', 'test-actor');
      const restored = await service.getTrustState(subjectRefB);
      expect(restored?.subject_id).toBe(subjectBId);
    });

    it('getEvidence returns the ledger for a subject, filterable by dimension', async () => {
      const all = await service.getEvidence(subjectRefA);
      expect(all.length).toBeGreaterThan(0);
      const eligibility = await service.getEvidence(subjectRefA, { dimension: 'ELIGIBILITY' });
      expect(eligibility.every((e) => e.dimension === 'ELIGIBILITY')).toBe(true);
    });

    it('recordDeclaredEvidenceForSubject writes declared IDENTITY evidence to a KNOWN subject (Cold-Ingest Extraction seam)', async () => {
      // Seed the subject (resolve-or-create via a SELF CLAIMS record) so we hold
      // its id — mirrors the extraction poll, which receives resolved_subject_id
      // on the arrival, NOT a per-payload ref.
      const seed = await service.recordEvidence({
        subjectRef: subjectRefC,
        dimension: 'CLAIMS',
        assertion_type: 'SKILL',
        assertion_payload: { value_raw: 'Go' },
        source_class: 'SELF',
        method: 'SELF_DECLARED',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'MODERATE',
        created_by: 'seed',
      });
      const subjectId = seed.subject_id;

      const preState = await service.getTrustState(subjectRefC);
      expect(preState?.identity_band).toBe('NOT_ESTABLISHED');

      const { evidence_ids } = await service.recordDeclaredEvidenceForSubject({
        tenant_id: TENANT,
        subject_id: subjectId,
        created_by: 'system:cold-ingest-extraction',
        entries: [
          {
            dimension: 'IDENTITY',
            assertion_type: 'FULL_NAME',
            assertion_payload: { first_name: 'Ada', last_name: 'Lovelace', payload_id: REF_C },
          },
          {
            dimension: 'IDENTITY',
            assertion_type: 'PHONE',
            assertion_payload: { value: '+15551234567', payload_id: REF_C },
          },
        ],
      });
      expect(evidence_ids).toHaveLength(2);

      const identity = await service.getEvidence(subjectRefC, { dimension: 'IDENTITY' });
      const byType = new Map(identity.map((e) => [e.assertion_type, e]));
      const fullName = byType.get('FULL_NAME');
      expect(fullName).toBeDefined();
      expect(fullName?.subject_id).toBe(subjectId);
      // Channel-sourced declared — never SELF, never verified.
      expect(fullName?.source_class).toBe('THIRD_PARTY_UNVERIFIED');
      expect(fullName?.method).toBe('DOCUMENT');
      expect(fullName?.current_status).toBe('VALID');
      expect(fullName?.ai_derived).toBe(false);
      expect(byType.get('PHONE')).toBeDefined();

      // The identity dimension now has evidence → no longer NOT_ESTABLISHED
      // (the promotion-unblock: a name now exists on the subject).
      const postState = await service.getTrustState(subjectRefC);
      expect(postState?.identity_band).not.toBe('NOT_ESTABLISHED');
    });

    it('Promotion Gate seams: resolveSubjectRef + listSubjectRefs + attachSubjectRef (attach ATS_TALENT_RECORD to a cold-ingest subject, idempotent)', async () => {
      // Seed a cold-ingest-shaped subject keyed by a SOURCED_TALENT ref (a
      // payload id) — the pre-promotion attachment point.
      const payloadId = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
      const sourcedRef: SubjectRef = {
        tenant_id: TENANT,
        ref_type: 'SOURCED_TALENT',
        ref_id: payloadId,
        link_source: 'promotion-seam-integration',
      };
      const seeded = await service.recordEvidence({
        subjectRef: sourcedRef,
        dimension: 'IDENTITY',
        assertion_type: 'FULL_NAME',
        assertion_payload: { first_name: 'Alan', last_name: 'Turing' },
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: 'seed',
      });
      const subjectId = seeded.subject_id;

      // resolveSubjectRef exposes the (merge-followed) subject id.
      const resolved = await service.resolveSubjectRef(sourcedRef);
      expect(resolved?.id).toBe(subjectId);

      // Before link: only the SOURCED_TALENT ref, no record ref.
      const before = await service.listSubjectRefs(TENANT, subjectId);
      expect(before.map((r) => r.ref_type)).toEqual(['SOURCED_TALENT']);
      expect(before.find((r) => r.ref_type === 'ATS_TALENT_RECORD')).toBeUndefined();

      // Attach the ATS_TALENT_RECORD ref (the promotion link).
      const recordId = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
      await service.attachSubjectRef({
        tenant_id: TENANT,
        subject_id: subjectId,
        ref_type: 'ATS_TALENT_RECORD',
        ref_id: recordId,
        link_source: 'promotion-gate-create',
      });

      const after = await service.listSubjectRefs(TENANT, subjectId);
      const recordRef = after.find((r) => r.ref_type === 'ATS_TALENT_RECORD');
      expect(recordRef?.ref_id).toBe(recordId);
      expect(recordRef?.link_source).toBe('promotion-gate-create');

      // Idempotent: re-attaching the same ref is a no-op (no duplicate row).
      await service.attachSubjectRef({
        tenant_id: TENANT,
        subject_id: subjectId,
        ref_type: 'ATS_TALENT_RECORD',
        ref_id: recordId,
        link_source: 'promotion-gate-create',
      });
      const afterReattach = await service.listSubjectRefs(TENANT, subjectId);
      expect(afterReattach.filter((r) => r.ref_type === 'ATS_TALENT_RECORD')).toHaveLength(1);

      // The record ref now resolves back to the SAME subject (findSubjectByRef).
      const viaRecord = await service.resolveSubjectRef({
        tenant_id: TENANT,
        ref_type: 'ATS_TALENT_RECORD',
        ref_id: recordId,
      });
      expect(viaRecord?.id).toBe(subjectId);
    });

    it('Reconcile poll: findSubjectsNeedingReconcile selects promoted subjects with newer evidence; markReconciled/bump gate it', async () => {
      // A promoted subject: keyed by SOURCED_TALENT, linked to a record, with
      // one declared identity fact.
      const payloadId = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
      const recordId = '99999999-9999-7999-8999-999999999999';
      const sourcedRef: SubjectRef = {
        tenant_id: TENANT,
        ref_type: 'SOURCED_TALENT',
        ref_id: payloadId,
        link_source: 'reconcile-poll-integration',
      };
      const seeded = await service.recordEvidence({
        subjectRef: sourcedRef,
        dimension: 'IDENTITY',
        assertion_type: 'FULL_NAME',
        assertion_payload: { first_name: 'Grace', last_name: 'Hopper' },
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: 'seed',
      });
      const subjectId = seeded.subject_id;
      await service.attachSubjectRef({
        tenant_id: TENANT,
        subject_id: subjectId,
        ref_type: 'ATS_TALENT_RECORD',
        ref_id: recordId,
        link_source: 'promotion-gate-create',
      });

      const mine = (rows: Array<{ subject_id: string; talent_record_id: string }>) =>
        rows.find((r) => r.subject_id === subjectId);

      // Never reconciled (watermark NULL) + has evidence → selected, carrying the
      // ATS record id to enrich.
      const before = await service.findSubjectsNeedingReconcile({ limit: 100, maxAttempts: 5 });
      expect(mine(before)?.talent_record_id).toBe(recordId);

      // Stamp the watermark → no evidence newer than it → dropped.
      await service.markReconciled(subjectId);
      const afterMark = await service.findSubjectsNeedingReconcile({ limit: 100, maxAttempts: 5 });
      expect(mine(afterMark)).toBeUndefined();

      // New evidence arrives (created_at > watermark) → re-selected.
      await service.recordEvidence({
        subjectRef: sourcedRef,
        dimension: 'IDENTITY',
        assertion_type: 'PHONE',
        assertion_payload: { value: '+15559990000' },
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: 'seed',
      });
      const afterNew = await service.findSubjectsNeedingReconcile({ limit: 100, maxAttempts: 5 });
      expect(mine(afterNew)?.subject_id).toBe(subjectId);

      // Attempt cap: bump to 5 → excluded at maxAttempts 5, re-admitted at 6.
      for (let i = 0; i < 5; i += 1) await service.bumpReconcileAttempt(subjectId);
      const atCap = await service.findSubjectsNeedingReconcile({ limit: 100, maxAttempts: 5 });
      expect(mine(atCap)).toBeUndefined();
      const higherCap = await service.findSubjectsNeedingReconcile({ limit: 100, maxAttempts: 6 });
      expect(mine(higherCap)?.subject_id).toBe(subjectId);
    });

    it('Promotion-Trigger guard: the partial-unique rejects a SECOND ATS_TALENT_RECORD ref on one subject (the race guard)', async () => {
      // Seed a subject; attach one ATS_TALENT_RECORD ref (the promotion link).
      const payloadId = '77777777-7777-7777-8777-777777777777';
      const sourcedRef: SubjectRef = {
        tenant_id: TENANT,
        ref_type: 'SOURCED_TALENT',
        ref_id: payloadId,
        link_source: 'ats-guard-integration',
      };
      const seeded = await service.recordEvidence({
        subjectRef: sourcedRef,
        dimension: 'IDENTITY',
        assertion_type: 'FULL_NAME',
        assertion_payload: { first_name: 'Ada', last_name: 'Byron' },
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: 'seed',
      });
      const subjectId = seeded.subject_id;
      await service.attachSubjectRef({
        tenant_id: TENANT,
        subject_id: subjectId,
        ref_type: 'ATS_TALENT_RECORD',
        ref_id: '88888888-8888-7888-8888-888888888881',
        link_source: 'promotion-gate-create',
      });

      // A SECOND, DIFFERENT ATS_TALENT_RECORD ref on the SAME subject — the
      // partial-unique (subject_id) WHERE ref_type='ATS_TALENT_RECORD' rejects it.
      // (attachSubjectRef dedupes only same ref_id; a distinct record id is the
      // double-mint race the DB guard closes.) Raw insert to bypass the app path.
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "talent_trust"."ResolutionSubjectRef" (id, subject_id, tenant_id, ref_type, ref_id, link_source)
           VALUES (gen_random_uuid(), '${subjectId}'::uuid, '${TENANT}'::uuid, 'ATS_TALENT_RECORD', '88888888-8888-7888-8888-888888888882'::uuid, 'race')`,
        ),
      ).rejects.toThrow();

      // A NON-ats ref (SOURCED_TALENT) on the same subject is unaffected (the
      // partial predicate only covers ATS_TALENT_RECORD).
      await service.attachSubjectRef({
        tenant_id: TENANT,
        subject_id: subjectId,
        ref_type: 'PERSON_CLUSTER',
        ref_id: '99999999-9999-7999-8999-999999999991',
        link_source: 'ok',
      });
      const refs = await service.listSubjectRefs(TENANT, subjectId);
      expect(refs.filter((r) => r.ref_type === 'ATS_TALENT_RECORD')).toHaveLength(1);
    });
  },
);
