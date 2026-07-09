import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TalentTrustRepository } from '../lib/talent-trust.repository.js';
import { SubjectMatcherService } from '../lib/subject-matcher.service.js';
import { TalentTrustService, type SubjectRef } from '../lib/talent-trust.service.js';

// TR-2a-B3a (DDR-3 §5) — the GLOBAL fixpoint + cluster-union read model, against
// real Postgres 17. Superseded ResolutionSubjects are seeded directly (pointer-
// only mergeSubjects); no reconcile writer exists this slice. Covers directive
// §5 acceptance tests:
//   (c) A→B→C resolves to C in resolveSubjectForRead AND the promotion gate's
//       resolve (resolveSubjectRef); a cycle anomaly fails LOUDLY.
//   (d) the intentional non-followers still resolve ORIGIN (anchors + refs stay
//       origin-keyed on a merged subject — the matcher pairs origins).
//   (e) evidence written to a merged husk surfaces in the survivor's cluster-
//       union getEvidence with origin provenance intact, and recompute(survivor)
//       folds it into TrustState.
//   (f) un-merge + recompute both → cleanly separated states (no blending to
//       undo — the sets were never merged, only read-time unioned).

const MIGRATIONS = [
  '../../prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  '../../prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  '../../prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  '../../prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
  '../../prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
  '../../prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
  '../../prisma/migrations/20260706230000_tr2a_b3b_subject_merge_operation/migration.sql',
  '../../prisma/migrations/20260707130000_tr6_b1_merge_operation_kind/migration.sql',
  '../../prisma/migrations/20260709120000_tr4_b1_evidence_link_unique/migration.sql',
  '../../prisma/migrations/20260710120000_tr4_b3_last_consistency_at/migration.sql',
  '../../prisma/migrations/20260711120000_tr5_b2_thinness_flags/migration.sql',
  '../../prisma/migrations/20260706170000_tr2a_b1_subject_anchor_source_class/migration.sql',
  '../../prisma/migrations/20260706180000_tr2a_b1_subject_anchor_source_class_unique/migration.sql',
  '../../prisma/migrations/20260706200000_tr2a_b2_advisory_reopen_provenance/migration.sql',
].map((p) => resolve(__dirname, p));

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = 'b3a-fixpoint-test';

// $$-aware DDL splitter (immutability trigger bodies carry `;` inside $$…$$).
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

function refFor(refId: string): SubjectRef {
  return { tenant_id: TENANT, ref_type: 'ATS_TALENT_RECORD', ref_id: refId, link_source: ACTOR };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-2a-B3a — global fixpoint + cluster-union reads (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TalentTrustRepository;
    let service: TalentTrustService;
    let matcher: SubjectMatcherService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          if (stmt.trim().length === 0) continue;
          await setup.$executeRawUnsafe(stmt.trim());
        }
      }
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new TalentTrustRepository(prisma);
      matcher = new SubjectMatcherService(repo);
      service = new TalentTrustService(repo, matcher);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    // Mint a subject bearing an ATS_TALENT_RECORD ref (so it is reachable by ref).
    async function mintSubjectWithRef(): Promise<{ subjectId: string; refId: string }> {
      const refId = uuidv7();
      const subjectId = await repo.resolveOrCreateSubject(TENANT, 'ATS_TALENT_RECORD', refId, ACTOR);
      return { subjectId, refId };
    }

    // Write one authoritative IDENTITY evidence directly onto a subject id (an
    // origin-keyed write — the husk-evidence case).
    async function writeAuthoritativeEvidence(subjectId: string): Promise<string> {
      const ev = await repo.insertEvidence({
        subject_id: subjectId,
        tenant_id: TENANT,
        dimension: 'IDENTITY',
        assertion_type: 'GOVERNMENT_ID',
        assertion_payload: { doc: 'passport' },
        source_class: 'AUTHORITATIVE_ISSUER',
        method: 'DOCUMENT',
        strength: 100,
        collected_at: new Date(),
        decay_profile: 'DURABLE',
        portability_class: 'TENANT_ONLY',
        ai_derived: false,
        current_status: 'VALID',
        created_by: ACTOR,
      });
      await repo.appendEvent({
        evidence_id: ev.id,
        tenant_id: TENANT,
        event_type: 'CREATED',
        actor: ACTOR,
        occurred_at: new Date(),
      });
      return ev.id;
    }

    // ---- (c) fixpoint globally + loud-fail anomaly ----------------------

    it('(c) A→B→C resolves to C in resolveSubjectForRead AND the promotion gate resolve', async () => {
      const a = await mintSubjectWithRef();
      const b = await mintSubjectWithRef();
      const c = await mintSubjectWithRef();

      // A→B→C: A merged into B, B merged into C, C stays ACTIVE.
      await service.mergeSubjects(b.subjectId, a.subjectId, 'chain A→B', 'test-actor');
      await service.mergeSubjects(c.subjectId, b.subjectId, 'chain B→C', 'test-actor');

      // resolveSubjectRef IS the promotion gate's resolve (promoteSubject →
      // resolveSubjectRef). Reading A's ref must reach C, not stop at B (1-hop).
      const resolved = await service.resolveSubjectRef(refFor(a.refId));
      expect(resolved?.id).toBe(c.subjectId);
      expect(resolved?.status).toBe('ACTIVE');

      // And the mid-chain ref (B) resolves to C as well.
      const resolvedB = await service.resolveSubjectRef(refFor(b.refId));
      expect(resolvedB?.id).toBe(c.subjectId);
    });

    it('(c) a merge-chain CYCLE fails loudly (never resolves to a plausible-but-wrong subject)', async () => {
      const x = await mintSubjectWithRef();
      const y = await mintSubjectWithRef();
      // Force a pointer cycle X→Y→X directly (a corrupt state the reconcile would
      // never create; the read-resolver must refuse it, not loop or mis-resolve).
      await repo.setSubjectMergeState(x.subjectId, 'MERGED', y.subjectId);
      await repo.setSubjectMergeState(y.subjectId, 'MERGED', x.subjectId);

      await expect(service.resolveSubjectRef(refFor(x.refId))).rejects.toThrow(/CYCLE/i);
    });

    // ---- (d) intentional non-followers stay origin-keyed ----------------

    it('(d) anchors and refs stay ORIGIN-keyed on a merged subject (non-followers unchanged)', async () => {
      const survivor = await mintSubjectWithRef();
      const husk = await mintSubjectWithRef();

      // Anchor on the husk BEFORE merge (origin-keyed).
      await repo.insertAnchor({
        evidence: {
          subject_id: husk.subjectId,
          tenant_id: TENANT,
          dimension: 'IDENTITY',
          assertion_type: 'EMAIL',
          assertion_payload: { normalized_value: 'origin@example.com' },
          source_class: 'SELF',
          method: 'SELF_DECLARED',
          strength: 10,
          collected_at: new Date(),
          decay_profile: 'SLOW',
          portability_class: 'TENANT_ONLY',
          ai_derived: false,
          current_status: 'VALID',
          created_by: ACTOR,
        },
        anchor_kind: 'EMAIL',
        normalized_value: 'origin@example.com',
      });

      await service.mergeSubjects(survivor.subjectId, husk.subjectId, 'merge husk into survivor', 'test-actor');

      // listAnchorsBySubject on the husk still returns the husk's OWN anchor
      // (origin-keyed — NOT re-homed to the survivor).
      const huskAnchors = await repo.listAnchorsBySubject(husk.subjectId);
      expect(huskAnchors).toHaveLength(1);
      expect(huskAnchors[0]!.subject_id).toBe(husk.subjectId);
      const survivorAnchors = await repo.listAnchorsBySubject(survivor.subjectId);
      expect(survivorAnchors).toHaveLength(0);

      // listSubjectRefs (intentional non-follower) returns the husk's OWN refs.
      const huskRefs = await service.listSubjectRefs(TENANT, husk.subjectId);
      expect(huskRefs.map((r) => r.ref_id)).toContain(husk.refId);
      expect(huskRefs.map((r) => r.ref_id)).not.toContain(survivor.refId);

      // The matcher keyed by the husk's ref resolves the husk ORIGIN (does not
      // follow to the survivor) — its anchor value is intact for pairing.
      const advisories = await matcher.matchForRef(TENANT, 'ATS_TALENT_RECORD', husk.refId);
      // No other subject shares the value → no advisory, but the call resolves the
      // origin subject without throwing (the non-follower path).
      expect(Array.isArray(advisories)).toBe(true);
    });

    // ---- (e) cluster-union evidence + recompute -------------------------

    it('(e) husk evidence surfaces in the survivor cluster-union read with origin provenance, and recompute folds it in', async () => {
      const survivor = await mintSubjectWithRef();
      const husk = await mintSubjectWithRef();
      await service.mergeSubjects(survivor.subjectId, husk.subjectId, 'merge for union read', 'test-actor');

      // Evidence written to the merged husk (origin-keyed write — stays on husk).
      const evId = await writeAuthoritativeEvidence(husk.subjectId);

      // getEvidence(survivor ref) resolves to the survivor fixpoint, then unions
      // the cluster — the husk's row surfaces with its ORIGIN subject_id intact.
      const union = await service.getEvidence(refFor(survivor.refId));
      const found = union.find((e) => e.id === evId);
      expect(found).toBeDefined();
      expect(found!.subject_id).toBe(husk.subjectId); // provenance UNTOUCHED

      // recompute(survivor) folds the cluster evidence into the survivor's
      // TrustState (an AUTHORITATIVE IDENTITY doc → not NOT_ESTABLISHED).
      await service.recomputeTrustState(survivor.subjectId, TENANT);
      const survivorState = await service.getTrustState(refFor(survivor.refId));
      expect(survivorState?.subject_id).toBe(survivor.subjectId);
      expect(survivorState?.identity_band).not.toBe('NOT_ESTABLISHED');
    });

    // ---- (f) un-merge separates cleanly ---------------------------------

    it('(f) un-merge + recompute both → cleanly separated states (no blending to undo)', async () => {
      const survivor = await mintSubjectWithRef();
      const husk = await mintSubjectWithRef();
      await service.mergeSubjects(survivor.subjectId, husk.subjectId, 'merge before un-merge', 'test-actor');
      await writeAuthoritativeEvidence(husk.subjectId);
      await service.recomputeTrustState(survivor.subjectId, TENANT);

      // Pre-un-merge: the survivor's state reflects the husk's evidence (union).
      const preState = await service.getTrustState(refFor(survivor.refId));
      expect(preState?.identity_band).not.toBe('NOT_ESTABLISHED');

      // Un-merge, then recompute BOTH.
      await service.unmergeSubjects(husk.subjectId, 'reviewer error', 'test-actor');
      await service.recomputeTrustState(survivor.subjectId, TENANT);
      await service.recomputeTrustState(husk.subjectId, TENANT);

      // The survivor's cluster is now itself — the husk's evidence drops out.
      const survivorAfter = await service.getTrustState(refFor(survivor.refId));
      expect(survivorAfter?.identity_band).toBe('NOT_ESTABLISHED');

      // The former husk (now ACTIVE) owns its evidence in its own right.
      const huskAfter = await service.getTrustState(refFor(husk.refId));
      expect(huskAfter?.subject_id).toBe(husk.subjectId);
      expect(huskAfter?.identity_band).not.toBe('NOT_ESTABLISHED');
    });
  },
);
