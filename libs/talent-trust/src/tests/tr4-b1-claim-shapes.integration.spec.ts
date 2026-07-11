import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentTrustRepository } from '../lib/talent-trust.repository.js';
import { SubjectMatcherService } from '../lib/subject-matcher.service.js';
import { TalentTrustService, type SubjectRef } from '../lib/talent-trust.service.js';

// TR-4 B1 (§5 a/c/d/e) — the claim-shape substrate over real Postgres 17.
// Proves at the WRITE PATH + DB: the canonical-shape gate (registered refuses /
// unregistered passes), the contact canary emitting `value` while a legacy row
// still reads, the EvidenceLink uniqueness (DB reject + service no-op), and the
// closure arm lifting the CORROBORATED cap.

const MIGRATIONS = [
  '20260628000000_init_talent_trust',
  '20260703120000_tr2a1_subject_anchor',
  '20260705120000_add_reconcile_watermark_to_resolution_subject',
  '20260706120000_ats_ref_partial_unique',
  '20260706170000_tr2a_b1_subject_anchor_source_class',
  '20260706180000_tr2a_b1_subject_anchor_source_class_unique',
  '20260706230000_tr2a_b3b_subject_merge_operation',
  '20260707120000_tr6_b1_last_matched_at',
  '20260707130000_tr6_b1_merge_operation_kind',
  '20260709120000_tr4_b1_evidence_link_unique',
  '20260710120000_tr4_b3_last_consistency_at',
  '20260711120000_tr5_b2_thinness_flags',
  '20260712120000_tr8_b1_verified_control_stale',
  '20260713120000_tr12_b1_verification_proposal',
].map((d) => resolve(__dirname, `../../prisma/migrations/${d}/migration.sql`));

// $$-aware DDL splitter (trigger bodies carry semicolons inside $$ … $$).
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

const TENANT = '11111111-1111-7111-8111-111111111111';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-4 B1 — canonical claim shapes + link uniqueness + closure arm (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TalentTrustRepository;
    let service: TalentTrustService;

    function refFor(refId: string): SubjectRef {
      return { tenant_id: TENANT, ref_type: 'ATS_TALENT_RECORD', ref_id: refId, link_source: 'tr4-b1' };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const p of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) {
          const trimmed = stmt.trim();
          if (trimmed.length > 0) await setup.$executeRawUnsafe(trimmed);
        }
      }
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new TalentTrustRepository(prisma);
      service = new TalentTrustService(repo, new SubjectMatcherService(repo));
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    // ---- (a) the write-path gate --------------------------------------------

    it('(a) a REGISTERED type with a canonical payload writes + persists the normalized shape', async () => {
      const ev = await service.recordEvidence({
        subjectRef: refFor(uuidv7()),
        dimension: 'CLAIMS',
        assertion_type: 'EMPLOYMENT',
        assertion_payload: {
          employer_raw: 'Acme Inc.',
          role_title_raw: 'Engineer',
          start_date_raw: '2020-01',
          end_date_raw: 'garbage-date',
        },
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: 'tr4-test',
      });
      const row = await repo.findEvidenceById(ev.id);
      const p = row?.assertion_payload as Record<string, unknown>;
      expect(p['employer_norm']).toBe('acme');
      expect(p['start_date']).toBe('2020-01-01');
      // Unparseable date → null, WITH raw preserved (never guessed).
      expect(p['end_date']).toBeNull();
      expect(p['end_date_raw']).toBe('garbage-date');
    });

    it('(a) a REGISTERED type with a malformed payload refuses (CLAIM_SHAPE_INVALID)', async () => {
      let code: string | undefined;
      try {
        await service.recordEvidence({
          subjectRef: refFor(uuidv7()),
          dimension: 'CLAIMS',
          assertion_type: 'EMPLOYMENT',
          assertion_payload: { role_title_raw: 'Engineer' }, // no employer_raw
          source_class: 'SELF',
          method: 'SELF_DECLARED',
          portability_class: 'TENANT_ONLY',
          decay_profile: 'SLOW',
          created_by: 'tr4-test',
        });
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe('CLAIM_SHAPE_INVALID');
    });

    it('(a) an UNREGISTERED type with any object still writes (admission open)', async () => {
      const ev = await service.recordEvidence({
        subjectRef: refFor(uuidv7()),
        dimension: 'CLAIMS',
        assertion_type: 'RIGHT_TO_WORK', // not in CANONICAL_CLAIM_SHAPES (DEGREE is now registered — TR-7 B1)
        assertion_payload: { whatever: 'free form', nested: { x: 1 } },
        source_class: 'SELF',
        method: 'SELF_DECLARED',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: 'tr4-test',
      });
      expect(ev.current_status).toBe('VALID');
      const row = await repo.findEvidenceById(ev.id);
      expect(row?.assertion_payload).toEqual({ whatever: 'free form', nested: { x: 1 } });
    });

    // ---- (c) the contact canary ---------------------------------------------

    it('(c) recordAnchor now emits canonical `value`; a seeded legacy `normalized_value` row still reads via dual-read', async () => {
      const recordId = uuidv7();
      const written = await service.recordAnchor({
        tenant_id: TENANT,
        talent_record_id: recordId,
        anchor_kind: 'EMAIL',
        normalized_value: 'ada@example.com',
        raw_source: 'Ada@Example.com',
        created_by: 'tr4-test',
      });
      expect(written).not.toBeNull();
      const anchorEv = await repo.findEvidenceById(written!.evidence.id);
      const p = anchorEv?.assertion_payload as Record<string, unknown>;
      // Converged forward: canonical key `value`, legacy key absent on new rows.
      expect(p['value']).toBe('ada@example.com');
      expect(p['normalized_value']).toBeUndefined();

      // A pre-convergence row (append-only history) keyed `normalized_value` still
      // exists + reads — proving the dual-read is still needed (no rewrite).
      const legacyId = uuidv7();
      await prisma.$executeRawUnsafe(
        `INSERT INTO talent_trust."EvidenceRecord"
           (id, subject_id, tenant_id, dimension, assertion_type, assertion_payload,
            source_class, method, strength, collected_at, decay_profile,
            portability_class, ai_derived, current_status, created_by, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'IDENTITY', 'EMAIL',
                 '{"normalized_value":"legacy@example.com"}'::jsonb,
                 'SELF', 'SELF_DECLARED', 0.05, now(), 'SLOW', 'TENANT_ONLY',
                 false, 'VALID', 'legacy-writer', now())`,
        legacyId,
        written!.evidence.subject_id,
        TENANT,
      );
      const legacyRow = await repo.findEvidenceById(legacyId);
      const lp = legacyRow?.assertion_payload as Record<string, unknown>;
      // The dual-read pattern (normalized_value ?? value) still resolves it.
      const dualRead = (lp['normalized_value'] as string) ?? (lp['value'] as string);
      expect(dualRead).toBe('legacy@example.com');
    });

    // ---- (d) link uniqueness (DB reject + service no-op) ---------------------

    it('(d) the DB rejects a duplicate (from,to,relation) link', async () => {
      const from = uuidv7();
      const to = uuidv7();
      await prisma.$executeRawUnsafe(
        `INSERT INTO talent_trust."EvidenceLink" (id, from_evidence_id, to_evidence_id, relation, tenant_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'CONTRADICTS', $4::uuid)`,
        uuidv7(), from, to, TENANT,
      );
      let rejected = false;
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO talent_trust."EvidenceLink" (id, from_evidence_id, to_evidence_id, relation, tenant_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'CONTRADICTS', $4::uuid)`,
          uuidv7(), from, to, TENANT,
        );
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });

    it('(d) a repeat contradict() is a service-side NO-OP (one link, one CONTRADICTED, no error)', async () => {
      const ref = refFor(uuidv7());
      const incumbent = await service.recordEvidence({
        subjectRef: ref, dimension: 'ELIGIBILITY', assertion_type: 'RIGHT_TO_WORK',
        assertion_payload: { status: 'authorized' }, source_class: 'AUTHORITATIVE_ISSUER',
        method: 'DOCUMENT', source_ref: { issuer: 'USCIS' }, portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW', created_by: 'tr4-test',
      });
      const challenger = await service.recordEvidence({
        subjectRef: ref, dimension: 'ELIGIBILITY', assertion_type: 'RIGHT_TO_WORK',
        assertion_payload: { status: 'not_authorized' }, source_class: 'THIRD_PARTY_VERIFIED',
        method: 'DOCUMENT', source_ref: { issuer: 'vendor' }, portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW', created_by: 'tr4-test',
      });

      await service.contradict(incumbent.id, challenger.id, 'first raise');
      // Repeat — must NOT throw and must NOT duplicate.
      await service.contradict(incumbent.id, challenger.id, 'second raise (no-op)');

      const links = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM talent_trust."EvidenceLink"
         WHERE relation = 'CONTRADICTS' AND from_evidence_id = $1::uuid AND to_evidence_id = $2::uuid`,
        challenger.id, incumbent.id,
      );
      expect(Number(links[0].count)).toBe(1);
      const events = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM talent_trust."EvidenceEvent"
         WHERE evidence_id = $1::uuid AND event_type = 'CONTRADICTED'`,
        incumbent.id,
      );
      expect(Number(events[0].count)).toBe(1);
    });

    // ---- (e) the closure arm ------------------------------------------------

    it('(e) resolveContradiction: CONTRADICTED → VALID with actor+reason, cap lifts; non-CONTRADICTED refuses', async () => {
      const ref = refFor(uuidv7());
      const incumbent = await service.recordEvidence({
        subjectRef: ref, dimension: 'ELIGIBILITY', assertion_type: 'RIGHT_TO_WORK',
        assertion_payload: { status: 'authorized' }, source_class: 'AUTHORITATIVE_ISSUER',
        method: 'DOCUMENT', source_ref: { issuer: 'USCIS' }, portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW', created_by: 'tr4-test',
      });
      const challenger = await service.recordEvidence({
        subjectRef: ref, dimension: 'ELIGIBILITY', assertion_type: 'RIGHT_TO_WORK',
        assertion_payload: { status: 'not_authorized' }, source_class: 'THIRD_PARTY_VERIFIED',
        method: 'DOCUMENT', source_ref: { issuer: 'vendor' }, portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW', created_by: 'tr4-test',
      });

      expect((await service.getTrustState(ref))?.eligibility_band).toBe('INDEPENDENTLY_VERIFIED');

      await service.contradict(incumbent.id, challenger.id, 'conflict');
      const capped = await service.getTrustState(ref);
      expect(capped?.eligibility_band).toBe('CORROBORATED');
      expect(capped?.open_contradiction_count).toBe(1);

      // Resolving a NON-contradicted record refuses.
      await expect(
        service.resolveContradiction(challenger.id, 'reviewer', 'not contradicted'),
      ).rejects.toThrow(/CONTRADICTED/);

      // Resolve the actual contradiction → VALID, event carries actor+reason.
      await service.resolveContradiction(incumbent.id, 'reviewer-1', 'registry re-confirmed');
      const resolvedRow = await repo.findEvidenceById(incumbent.id);
      expect(resolvedRow?.current_status).toBe('VALID');

      const evrow = await prisma.$queryRawUnsafe<{ actor: string; reason: string }[]>(
        `SELECT actor, reason FROM talent_trust."EvidenceEvent"
         WHERE evidence_id = $1::uuid AND event_type = 'CONTRADICTION_RESOLVED'`,
        incumbent.id,
      );
      expect(evrow[0]?.actor).toBe('reviewer-1');
      expect(evrow[0]?.reason).toBe('registry re-confirmed');

      // The cap lifted — band recovers, count drops.
      const lifted = await service.getTrustState(ref);
      expect(lifted?.eligibility_band).toBe('INDEPENDENTLY_VERIFIED');
      expect(lifted?.open_contradiction_count).toBe(0);
    });
  },
);
