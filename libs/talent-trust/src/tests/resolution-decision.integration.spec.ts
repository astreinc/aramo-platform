import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import {
  TalentTrustRepository,
  type InsertAnchorInput,
} from '../lib/talent-trust.repository.js';
import {
  TalentTrustService,
  type RecordSourcedArrivalInput,
} from '../lib/talent-trust.service.js';
import { SubjectMatcherService } from '../lib/subject-matcher.service.js';
import { SubjectResolutionService } from '../lib/subject-resolution.service.js';
import type { SourceClass } from '../lib/vocab.js';

// TR-2a-B2 (DDR-2 §2/§3/§4/§5 + Amendment §2 + Name-Wiring §1) — the arrival-time
// resolve DECISION acceptance tests (a)-(j), against real Postgres 17.

const MIGRATIONS = [
  '../../prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  '../../prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  '../../prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  '../../prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
  '../../prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
  '../../prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
  '../../prisma/migrations/20260706230000_tr2a_b3b_subject_merge_operation/migration.sql',
  '../../prisma/migrations/20260707130000_tr6_b1_merge_operation_kind/migration.sql',
  '../../prisma/migrations/20260706170000_tr2a_b1_subject_anchor_source_class/migration.sql',
  '../../prisma/migrations/20260706180000_tr2a_b1_subject_anchor_source_class_unique/migration.sql',
  '../../prisma/migrations/20260706200000_tr2a_b2_advisory_reopen_provenance/migration.sql',
].map((p) => resolve(__dirname, p));

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = 'b2-decision-test';

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

function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-2a-B2 — arrival-time resolve decision procedure (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TalentTrustRepository;
    let service: TalentTrustService;
    let matcher: SubjectMatcherService;
    let resolutionSvc: SubjectResolutionService;

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
      resolutionSvc = new SubjectResolutionService(repo);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    // ---- helpers ---------------------------------------------------------

    function arrival(o: Partial<RecordSourcedArrivalInput>): RecordSourcedArrivalInput {
      return {
        tenant_id: TENANT,
        payload_id: uuidv7(),
        verified_email: null,
        profile_url: null,
        source_channel: 'test',
        source_class: 'THIRD_PARTY_UNVERIFIED',
        declared_name: null,
        created_by: ACTOR,
        ...o,
      };
    }

    // A confirming (THIRD_PARTY_VERIFIED) email anchor minted DIRECTLY on a fresh
    // subject — used to build confirming targets (the arrival path never mints a
    // confirming anchor today, so tests construct them).
    async function mintConfirmingSubject(email: string): Promise<string> {
      const subjectId = await repo.resolveOrCreateSubject(
        TENANT,
        'ATS_TALENT_RECORD',
        uuidv7(),
        ACTOR,
      );
      const evidence: InsertAnchorInput = {
        evidence: {
          subject_id: subjectId,
          tenant_id: TENANT,
          dimension: 'IDENTITY',
          assertion_type: 'EMAIL',
          assertion_payload: { normalized_value: email },
          source_class: 'THIRD_PARTY_VERIFIED',
          method: 'DOCUMENT',
          strength: 0,
          collected_at: new Date(),
          decay_profile: 'SLOW',
          portability_class: 'TENANT_ONLY',
          ai_derived: false,
          current_status: 'VALID',
          created_by: ACTOR,
        },
        anchor_kind: 'EMAIL',
        normalized_value: email,
      };
      await repo.insertAnchor(evidence);
      return subjectId;
    }

    async function addName(subjectId: string, first: string, last: string): Promise<void> {
      await service.recordDeclaredEvidenceForSubject({
        tenant_id: TENANT,
        subject_id: subjectId,
        entries: [
          {
            dimension: 'IDENTITY',
            assertion_type: 'FULL_NAME',
            assertion_payload: { first_name: first, last_name: last },
          },
        ],
        created_by: ACTOR,
      });
    }

    function email(): string {
      return `u-${uuidv7()}@example.com`;
    }

    async function advisoryFor(a: string, b: string) {
      const [lo, hi] = pairKey(a, b);
      return repo.findMatchAdvisory(TENANT, lo, hi);
    }

    // ---- (a) --------------------------------------------------------------
    it('(a) unverified-vs-verified hit does NOT resolve and DOES raise an advisory', async () => {
      const e = email();
      const target = await mintConfirmingSubject(e);
      const r = await service.recordSourcedArrival(
        arrival({ verified_email: e, source_class: 'THIRD_PARTY_UNVERIFIED' }),
      );
      expect(r.subject_id).not.toBe(target); // no auto-resolve — C_in non-confirming
      expect(r.resolution_method).toBe('new_identity');
      const adv = await advisoryFor(r.subject_id, target);
      expect(adv).not.toBeNull(); // the hand-off raised the advisory
    });

    // ---- (b) --------------------------------------------------------------
    it('(b) confirming-confirming single-target resolves (confirmed_anchor_match)', async () => {
      const e = email();
      const target = await mintConfirmingSubject(e);
      const r = await service.recordSourcedArrival(
        arrival({ verified_email: e, source_class: 'THIRD_PARTY_VERIFIED' }),
      );
      expect(r.subject_id).toBe(target); // auto-resolved onto the target
      expect(r.resolution_method).toBe('confirmed_anchor_match');
    });

    // ---- (c) --------------------------------------------------------------
    it('(c) ambiguity arm — ≥2 confirming targets → new subject + the advisory triangle', async () => {
      const e = email();
      const s1 = await mintConfirmingSubject(e);
      const s2 = await mintConfirmingSubject(e);
      const r = await service.recordSourcedArrival(
        arrival({ verified_email: e, source_class: 'THIRD_PARTY_VERIFIED' }),
      );
      expect(r.subject_id).not.toBe(s1);
      expect(r.subject_id).not.toBe(s2);
      expect(r.resolution_method).toBe('new_identity'); // NO auto-resolve on ambiguity
      // The triangle: new↔s1, new↔s2, AND s1↔s2 (each conflicting target handed off).
      expect(await advisoryFor(r.subject_id, s1)).not.toBeNull();
      expect(await advisoryFor(r.subject_id, s2)).not.toBeNull();
      expect(await advisoryFor(s1, s2)).not.toBeNull();
    });

    // ---- (d) --------------------------------------------------------------
    it('(d) arrival aimed at a MERGED subject lands on the ACTIVE fixpoint (A→B→C resolves to C)', async () => {
      const e = email();
      // A carries the confirming anchor; A→B→C, C is ACTIVE.
      const a = await mintConfirmingSubject(e);
      const b = await repo.resolveOrCreateSubject(TENANT, 'ATS_TALENT_RECORD', uuidv7(), ACTOR);
      const c = await repo.resolveOrCreateSubject(TENANT, 'ATS_TALENT_RECORD', uuidv7(), ACTOR);
      await service.mergeSubjects(b, a, 'chain A→B', 'test-actor'); // A merged into B
      await service.mergeSubjects(c, b, 'chain B→C', 'test-actor'); // B merged into C
      const r = await service.recordSourcedArrival(
        arrival({ verified_email: e, source_class: 'THIRD_PARTY_VERIFIED' }),
      );
      expect(r.subject_id).toBe(c); // followed the chain to the ACTIVE fixpoint
      expect(r.resolution_method).toBe('confirmed_anchor_match');
    });

    // ---- (e) --------------------------------------------------------------
    it('(e) dismissed pair re-opens on strictly-stronger with provenance; no drift / no re-open otherwise', async () => {
      const s1 = await repo.resolveOrCreateSubject(TENANT, 'ATS_TALENT_RECORD', uuidv7(), ACTOR);
      const s2 = await repo.resolveOrCreateSubject(TENANT, 'ATS_TALENT_RECORD', uuidv7(), ACTOR);
      const [lo, hi] = pairKey(s1, s2);
      const shared1 = [{ anchor_kind: 'EMAIL' as const, a_anchor_id: 'a1', b_anchor_id: 'b1' }];
      const shared2 = [
        ...shared1,
        { anchor_kind: 'PHONE' as const, a_anchor_id: 'a2', b_anchor_id: 'b2' },
      ];

      // Weak advisory, then a human dismisses it.
      const adv = await repo.upsertMatchAdvisory({
        tenant_id: TENANT,
        subject_a_id: lo,
        subject_b_id: hi,
        advise_band: 'ADVISE_WEAK',
        has_contradiction: false,
        match_basis: { shared: shared1, contradiction_kinds: [], confirmed_kinds: [] },
        created_by: ACTOR,
      });
      await resolutionSvc.dismiss({ tenant_id: TENANT, advisory_id: adv.id, actor: ACTOR });

      // Same evidence → strict NO-OP (no field drift, no re-open).
      await repo.upsertMatchAdvisory({
        tenant_id: TENANT,
        subject_a_id: lo,
        subject_b_id: hi,
        advise_band: 'ADVISE_WEAK',
        has_contradiction: false,
        match_basis: { shared: shared1, contradiction_kinds: [], confirmed_kinds: [] },
        created_by: ACTOR,
      });
      let after = await repo.findMatchAdvisory(TENANT, lo, hi);
      expect(after!.status).toBe('DISMISSED');
      expect(after!.reopened_at).toBeNull();

      // A NEW corroborator conflict does NOT re-open (Amendment §2.3).
      await repo.upsertMatchAdvisory({
        tenant_id: TENANT,
        subject_a_id: lo,
        subject_b_id: hi,
        advise_band: 'ADVISE_WEAK',
        has_contradiction: false,
        match_basis: { shared: shared1, contradiction_kinds: [], confirmed_kinds: [] },
        corroborator_conflict_kinds: ['NAME'],
        created_by: ACTOR,
      });
      after = await repo.findMatchAdvisory(TENANT, lo, hi);
      expect(after!.status).toBe('DISMISSED');
      expect(after!.reopened_at).toBeNull();

      // Strictly stronger (shared count 1 → 2) → RE-OPEN with provenance.
      await repo.upsertMatchAdvisory({
        tenant_id: TENANT,
        subject_a_id: lo,
        subject_b_id: hi,
        advise_band: 'ADVISE_STRONG',
        has_contradiction: false,
        match_basis: { shared: shared2, contradiction_kinds: [], confirmed_kinds: [] },
        created_by: ACTOR,
      });
      after = await repo.findMatchAdvisory(TENANT, lo, hi);
      expect(after!.status).toBe('PENDING_REVIEW');
      expect(after!.reopened_at).not.toBeNull();
      expect(after!.reopened_from_band).toBe('ADVISE_WEAK');
    });

    // ---- (f) --------------------------------------------------------------
    it('(f) confirming-both + zero-overlap names → NO resolve; advisory carries the NAME conflict; approve needs override', async () => {
      const e = email();
      const target = await mintConfirmingSubject(e);
      await addName(target, 'Jane', 'Doe');
      const r = await service.recordSourcedArrival(
        arrival({
          verified_email: e,
          source_class: 'THIRD_PARTY_VERIFIED',
          declared_name: 'Priya Sharma',
        }),
      );
      expect(r.subject_id).not.toBe(target); // demoted out of CONFIRMED
      expect(r.resolution_method).toBe('new_identity');

      const adv = await advisoryFor(r.subject_id, target);
      expect(adv).not.toBeNull();
      const basis = adv!.match_basis as {
        confirmed_kinds?: string[];
        corroborator_conflict_kinds?: string[];
      };
      expect(basis.confirmed_kinds).toContain('EMAIL'); // both sides confirming
      expect(adv!.has_contradiction).toBe(true);
      expect(basis.corroborator_conflict_kinds).toEqual(['NAME']);

      // Approving that merge requires the contradiction override.
      await expect(
        resolutionSvc.approveMerge({ tenant_id: TENANT, advisory_id: adv!.id, actor: ACTOR }),
      ).rejects.toThrow(/contradiction_override_required/);
    });

    // ---- (g) --------------------------------------------------------------
    it('(g) token-overlapping names (Bob Smith / Robert Smith) → auto-resolve', async () => {
      const e = email();
      const target = await mintConfirmingSubject(e);
      await addName(target, 'Robert', 'Smith');
      const r = await service.recordSourcedArrival(
        arrival({ verified_email: e, source_class: 'THIRD_PARTY_VERIFIED', declared_name: 'Bob Smith' }),
      );
      expect(r.subject_id).toBe(target); // shared token `smith` → no conflict
      expect(r.resolution_method).toBe('confirmed_anchor_match');
    });

    // ---- (h) --------------------------------------------------------------
    it('(h) name absent on a side → auto-resolves (absence never conflicts)', async () => {
      const e = email();
      const target = await mintConfirmingSubject(e);
      await addName(target, 'Jane', 'Doe');
      // Arrival supplies NO declared name → guard passes vacuously.
      const r = await service.recordSourcedArrival(
        arrival({ verified_email: e, source_class: 'THIRD_PARTY_VERIFIED', declared_name: null }),
      );
      expect(r.subject_id).toBe(target);
      expect(r.resolution_method).toBe('confirmed_anchor_match');
    });

    // ---- (i) --------------------------------------------------------------
    it('(i) the hand-off runs on every outcome and a hand-off failure propagates LOUDLY', async () => {
      const faultyMatcher = {
        matchSubject: async () => {
          throw new Error('handoff boom');
        },
      } as unknown as SubjectMatcherService;
      const faultyService = new TalentTrustService(repo, faultyMatcher);
      await expect(
        faultyService.recordSourcedArrival(arrival({ verified_email: email() })),
      ).rejects.toThrow(/handoff boom/);
    });

    // ---- (j) --------------------------------------------------------------
    it('(j) every currently-mapped live channel class lands in split/unresolved (nothing auto-resolves today)', async () => {
      // Even against a confirming target, a live channel C_in (SELF | UNVERIFIED)
      // never confirms → always split (the §1 product posture, proven).
      for (const cIn of ['SELF', 'THIRD_PARTY_UNVERIFIED'] as SourceClass[]) {
        const e = email();
        const target = await mintConfirmingSubject(e);
        const r = await service.recordSourcedArrival(
          arrival({ verified_email: e, source_class: cIn }),
        );
        expect(r.subject_id, `class=${cIn}`).not.toBe(target);
        expect(r.resolution_method, `class=${cIn}`).toBe('new_identity');
      }
    });
  },
);
