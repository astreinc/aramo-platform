import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SubjectMatcherService, FAN_OUT_CAP } from '../lib/subject-matcher.service.js';
import { TalentTrustRepository } from '../lib/talent-trust.repository.js';
import {
  TalentTrustService,
  type RecordSourcedArrivalInput,
} from '../lib/talent-trust.service.js';

// TR-6 B1 (DDR §8 acceptance) — the dedup-engine slice proven against real
// Postgres 17. Covers the matcher-core completions (D2 fixpoint keying, D3 fan-out
// guard) and the merge-audit completion (D4). The scheduled sweep (D1) + detection
// cron (D6) are proven in the apps/api maintenance spec (they compose these).
//   (ii)  a husk-sharer yields an ACTIVE↔ACTIVE advisory, never a husk-keyed one;
//         a self-pair (both fixpoint to one survivor) is skipped.
//   (iii) a K>FAN_OUT_CAP value produces zero advisories + one log line (kind+count,
//         never the value), proven here for the inline recordSourcedArrival hand-off;
//         K≤cap is unaffected.
//   (iv)  a direct merge + a direct unmerge each persist a SubjectMergeOperation row
//         carrying actor + reason (the formerly-voided string).

const MIGRATIONS = [
  '../../prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  '../../prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  '../../prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  '../../prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
  '../../prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
  '../../prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
  '../../prisma/migrations/20260706170000_tr2a_b1_subject_anchor_source_class/migration.sql',
  '../../prisma/migrations/20260706180000_tr2a_b1_subject_anchor_source_class_unique/migration.sql',
  '../../prisma/migrations/20260706200000_tr2a_b2_advisory_reopen_provenance/migration.sql',
  '../../prisma/migrations/20260706230000_tr2a_b3b_subject_merge_operation/migration.sql',
  '../../prisma/migrations/20260707130000_tr6_b1_merge_operation_kind/migration.sql',
].map((p) => resolve(__dirname, p));

const CREATED_BY = 'tr6-b1-engine-integration';
const ACTOR = 'actor:tr6-b1';

// $$-aware DDL splitter (trigger bodies contain semicolons inside $$ … $$).
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
  'TR-6 B1 dedup engine — fixpoint pairing + fan-out guard + merge audit (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let service: TalentTrustService;
    let matcher: SubjectMatcherService;
    let repo: TalentTrustRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          if (stmt.trim().length === 0) continue;
          await setupClient.$executeRawUnsafe(stmt.trim());
        }
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new TalentTrustRepository(prisma);
      matcher = new SubjectMatcherService(repo);
      service = new TalentTrustService(repo, matcher);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Seed a subject with the given anchors via the producer seam (one ATS
    // TalentRecord id → one subject). Returns the subject id.
    async function seed(
      tenantId: string,
      anchors: Array<{ kind: 'EMAIL' | 'PHONE'; value: string }>,
    ): Promise<string> {
      const talentRecordId = uuidv7();
      let subjectId: string | null = null;
      for (const anc of anchors) {
        const written = await service.recordAnchor({
          tenant_id: tenantId,
          talent_record_id: talentRecordId,
          anchor_kind: anc.kind,
          normalized_value: anc.value,
          raw_source: anc.value,
          created_by: CREATED_BY,
        });
        if (written !== null) subjectId = written.anchor.subject_id;
      }
      if (subjectId === null) throw new Error('seed recorded no anchors');
      return subjectId;
    }

    function arrival(tenantId: string, o: Partial<RecordSourcedArrivalInput>): RecordSourcedArrivalInput {
      return {
        tenant_id: tenantId,
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

    async function advisoriesFor(tenantId: string) {
      return prisma.subjectMatchAdvisory.findMany({ where: { tenant_id: tenantId } });
    }

    // ---- (ii) fixpoint pairing --------------------------------------------

    it('(ii) a husk-sharer yields an ACTIVE↔ACTIVE advisory keyed to the survivor, never the husk', async () => {
      const T = '1a111111-1111-7111-8111-111111111111';
      const a = await seed(T, [{ kind: 'EMAIL', value: 'husk-share@x.com' }]);
      const husk = await seed(T, [{ kind: 'EMAIL', value: 'husk-share@x.com' }]);
      const survivor = await seed(T, [{ kind: 'PHONE', value: '+15550000001' }]);

      // Merge the husk into a DIFFERENT survivor (survivor holds no shared email).
      await service.mergeSubjects(survivor, husk, 'merge husk into survivor', ACTOR);

      // Match A: it shares an email with the husk (origin). The advisory must key to
      // the husk's ACTIVE fixpoint (survivor), and A↔survivor are both ACTIVE.
      const advisories = await matcher.matchSubject(T, a);

      expect(advisories).toHaveLength(1);
      const adv = advisories[0]!;
      expect([adv.subject_a_id, adv.subject_b_id].sort()).toEqual([a, survivor].sort());
      // The husk-keyed noise the pre-D2 matcher produced is demonstrably gone.
      expect(adv.subject_a_id).not.toBe(husk);
      expect(adv.subject_b_id).not.toBe(husk);
    });

    it('(ii) a self-pair (both sides fixpoint to one survivor) is skipped — no advisory', async () => {
      const T = '1b111111-1111-7111-8111-111111111111';
      const x = await seed(T, [{ kind: 'EMAIL', value: 'self-pair@x.com' }]);
      const y = await seed(T, [{ kind: 'EMAIL', value: 'self-pair@x.com' }]);

      // Merge Y into X. Now X and its own husk Y share the email — a self-pair.
      await service.mergeSubjects(x, y, 'merge y into x', ACTOR);

      const advisories = await matcher.matchSubject(T, x);
      expect(advisories).toHaveLength(0);
      expect(await advisoriesFor(T)).toHaveLength(0);
    });

    // ---- (iii) fan-out guard (inline recordSourcedArrival) ----------------

    it('(iii) a K>FAN_OUT_CAP value produces ZERO advisories + one log line (never the value) inline', async () => {
      const T = '1c111111-1111-7111-8111-111111111111';
      const email = 'shared-mailbox@x.com';
      // Seed FAN_OUT_CAP + 1 distinct subjects sharing the value; the arrival makes
      // the ACTIVE-fixpoint sharer count exceed the cap.
      for (let i = 0; i <= FAN_OUT_CAP; i++) {
        await seed(T, [{ kind: 'EMAIL', value: email }]);
      }
      expect(await advisoriesFor(T)).toHaveLength(0);

      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      const result = await service.recordSourcedArrival(
        arrival(T, { verified_email: email, source_class: 'THIRD_PARTY_UNVERIFIED' }),
      );
      expect(result.resolution_method).toBe('new_identity');

      // Zero advisories minted despite the arrival sharing the value with 21 subjects.
      expect(await advisoriesFor(T)).toHaveLength(0);

      const fanOutLines = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('match_fan_out_capped'));
      expect(fanOutLines).toHaveLength(1);
      // PII discipline — the log carries kind + count, NEVER the value.
      expect(fanOutLines[0]).toContain('anchor_kind=EMAIL');
      expect(fanOutLines[0]).not.toContain(email);
    });

    it('(iii) a K≤FAN_OUT_CAP value is unaffected — advisories are minted inline', async () => {
      const T = '1d111111-1111-7111-8111-111111111111';
      const email = 'small-share@x.com';
      await seed(T, [{ kind: 'EMAIL', value: email }]);
      await seed(T, [{ kind: 'EMAIL', value: email }]);

      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      await service.recordSourcedArrival(
        arrival(T, { verified_email: email, source_class: 'THIRD_PARTY_UNVERIFIED' }),
      );

      // The arrival's new subject shares the value with 2 subjects (3 distinct ≤ cap)
      // → advisories are produced, no fan-out log.
      expect((await advisoriesFor(T)).length).toBeGreaterThan(0);
      const fanOutLines = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('match_fan_out_capped'));
      expect(fanOutLines).toHaveLength(0);
    });

    // ---- (iv) merge-audit completion --------------------------------------

    it('(iv) a direct merge persists a DIRECT_MERGE row with actor + reason', async () => {
      const T = '1e111111-1111-7111-8111-111111111111';
      const surviving = await seed(T, [{ kind: 'EMAIL', value: 'dm-survivor@x.com' }]);
      const merged = await seed(T, [{ kind: 'PHONE', value: '+15550000002' }]);

      await service.mergeSubjects(surviving, merged, 'reviewer confirmed same human', ACTOR);

      const ops = await prisma.subjectMergeOperation.findMany({
        where: { tenant_id: T, surviving_subject_id: surviving, merged_subject_id: merged },
      });
      expect(ops).toHaveLength(1);
      expect(ops[0]!.kind).toBe('DIRECT_MERGE');
      expect(ops[0]!.actor).toBe(ACTOR);
      expect(ops[0]!.reason).toBe('reviewer confirmed same human');
      expect(ops[0]!.surviving_record_id).toBeNull();
    });

    it('(iv) a direct unmerge with no prior operation persists a DIRECT_UNMERGE row with actor + reason', async () => {
      const T = '1f111111-1111-7111-8111-111111111111';
      const surviving = await seed(T, [{ kind: 'EMAIL', value: 'du-survivor@x.com' }]);
      const merged = await seed(T, [{ kind: 'PHONE', value: '+15550000003' }]);

      // Simulate a pre-B3b merge that left NO operation row (setSubjectMergeState direct).
      await repo.setSubjectMergeState(merged, 'MERGED', surviving);

      const restored = await service.unmergeSubjects(merged, 'reviewer error — undo', ACTOR);
      expect(restored.status).toBe('ACTIVE');

      const ops = await prisma.subjectMergeOperation.findMany({
        where: { tenant_id: T, merged_subject_id: merged, kind: 'DIRECT_UNMERGE' },
      });
      expect(ops).toHaveLength(1);
      expect(ops[0]!.actor).toBe(ACTOR);
      // The formerly-voided reason is now retrievable.
      expect(ops[0]!.reason).toBe('reviewer error — undo');
      // Terminal REVERSED, NOT COMPLETED — the advisory-resolution controller
      // reverses a merge only on a COMPLETED op; a DIRECT_UNMERGE audit row (no
      // merge topology) must never be picked up as a reversible merge.
      expect(ops[0]!.status).toBe('REVERSED');
      expect(ops[0]!.status).not.toBe('COMPLETED');
    });
  },
);
