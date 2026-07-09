import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TalentTrustService, TalentTrustRepository } from '@aramo/talent-trust';

import { AppModule } from '../app.module.js';
import { SourcingService } from '../talent-identity/sourcing.service.js';

const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);

// No new migration in T14-B1 — reads over existing tables. Same 20-migration
// list as TR-5 B2.
const MIGRATIONS = [
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/talent-trust/prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
  'libs/talent-trust/prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706120000_ats_ref_partial_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706160000_sourcing_pool_keyset_index/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706170000_tr2a_b1_subject_anchor_source_class/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706180000_tr2a_b1_subject_anchor_source_class_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706200000_tr2a_b2_advisory_reopen_provenance/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706230000_tr2a_b3b_subject_merge_operation/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707130000_tr6_b1_merge_operation_kind/migration.sql',
  'libs/talent-trust/prisma/migrations/20260708120000_tr3_b1_verification_request/migration.sql',
  'libs/talent-trust/prisma/migrations/20260709120000_tr4_b1_evidence_link_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260710120000_tr4_b3_last_consistency_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260711120000_tr5_b2_thinness_flags/migration.sql',
].map(M);

const TENANT = '01900000-0000-7000-8000-0000000000d1';
const ref = (talentId: string) => ({ tenant_id: TENANT, ref_type: 'ATS_TALENT_RECORD' as const, ref_id: talentId });

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-14 B1 — dossier reads (links, timeline, merge history) + one story + strip (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let db: Client;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let trust: TalentTrustService;
    let repo: TalentTrustRepository;
    let sourcing: SourcingService;

    async function seedEmployment(args: {
      talentId: string;
      employer: string;
      start: string | null;
      end: string | null;
      srcId: string;
    }): Promise<string> {
      const ev = await trust.recordEvidence({
        subjectRef: ref(args.talentId),
        dimension: 'CLAIMS',
        assertion_type: 'EMPLOYMENT',
        assertion_payload: {
          employer_raw: args.employer,
          role_title_raw: 'Engineer',
          ...(args.start !== null ? { start_date_raw: args.start } : {}),
          ...(args.end !== null ? { end_date_raw: args.end } : {}),
        },
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        source_ref: { talent_evidence_id: args.srcId },
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: 'test',
      });
      return ev.id;
    }
    async function subjectIdFor(talentId: string): Promise<string> {
      const s = await trust.resolveSubjectRef(ref(talentId));
      return s!.id;
    }
    async function mergeAndComplete(survivorId: string, mergedId: string): Promise<void> {
      await trust.mergeSubjects(survivorId, mergedId, 'test-merge', 'tester');
      const op = await repo.findMergeOperationBySubjects(TENANT, survivorId, mergedId);
      await repo.completeMergeOperation(op!.id, new Date());
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await db.query(`INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid, 'TR14B1', now()) ON CONFLICT DO NOTHING`, [TENANT]);
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'core') ON CONFLICT DO NOTHING`, [TENANT]);

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['MAILER_PROVIDER'] = process.env['MAILER_PROVIDER'];
      process.env['DATABASE_URL'] = url;
      process.env['MAILER_PROVIDER'] = 'stub';

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await module.init();
      trust = module.get(TalentTrustService);
      repo = module.get(TalentTrustRepository);
      sourcing = module.get(SourcingService);
    }, 300_000);

    afterAll(async () => {
      await module?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    beforeEach(async () => {
      for (const t of ['EvidenceLink', 'EvidenceEvent', 'EvidenceRecord', 'TrustState', 'ResolutionSubjectRef', 'ResolutionSubject', 'SubjectMergeOperation']) {
        await db.query(`TRUNCATE TABLE talent_trust."${t}" CASCADE`);
      }
    });

    // ---- (a) link read: relation-tagged, both directions, across a merged cluster ----

    it('(a) getEvidenceLinks returns CONTRADICTS + SUPERSEDES relation-tagged, across a merged cluster', async () => {
      const tA = uuidv7();
      const tB = uuidv7();
      const e1 = await seedEmployment({ talentId: tA, employer: 'acme', start: '2020-01-01', end: '2020-12-31', srcId: 'a1' });
      const e2 = await seedEmployment({ talentId: tB, employer: 'globex', start: '2020-06-01', end: '2021-06-30', srcId: 'b1' }); // on subject B
      const sidA = await subjectIdFor(tA);
      const sidB = await subjectIdFor(tB);
      await mergeAndComplete(sidA, sidB); // B merged into A → cluster [A,B]

      // A contradiction across the cluster (e1 on A, e2 on B) + a supersede chain.
      await trust.contradict(e1, e2, 'EMPLOYER_CONFLICT_SAME_WINDOW');
      const e3 = await seedEmployment({ talentId: tA, employer: 'initech', start: '2019-01-01', end: '2019-06-30', srcId: 'a2' });
      const e4 = await seedEmployment({ talentId: tA, employer: 'initech', start: '2019-01-01', end: '2019-07-31', srcId: 'a3' });
      await trust.supersede(e3, e4); // e4 SUPERSEDES e3

      const links = await trust.getEvidenceLinks(ref(tA));
      const relations = links.map((l) => l.relation).sort();
      expect(relations).toContain('CONTRADICTS');
      expect(relations).toContain('SUPERSEDES');
      // both directions surface: the CONTRADICTS link references e1/e2 (across the cluster)
      const contra = links.find((l) => l.relation === 'CONTRADICTS')!;
      expect([contra.from_evidence_id, contra.to_evidence_id].sort()).toEqual([e1, e2].sort());
      const sup = links.find((l) => l.relation === 'SUPERSEDES')!;
      expect([sup.from_evidence_id, sup.to_evidence_id].sort()).toEqual([e3, e4].sort());
    });

    // ---- (b) timeline read: keyset newest-first + the healed-gap story ----

    it('(b) getEvidenceTimeline pages keyset newest-first; the healed-gap story reads coherently', async () => {
      const t = uuidv7();
      // An interior >180d gap between two jobs → the detector opens a TIMELINE_GAP.
      await seedEmployment({ talentId: t, employer: 'acme', start: '2016-01-01', end: '2018-01-01', srcId: 'g1' });
      await seedEmployment({ talentId: t, employer: 'globex', start: '2020-01-01', end: '2021-01-01', srcId: 'g2' });
      const sid = await subjectIdFor(t);
      await trust.runConsistencyForSubject(TENANT, sid); // opens the gap (CREATED event)
      // Fill the gap → next run SUPERSEDES it (SUPERSEDED event) — the healed story.
      await seedEmployment({ talentId: t, employer: 'initech', start: '2018-06-01', end: '2019-12-01', srcId: 'g3' });
      await trust.runConsistencyForSubject(TENANT, sid);

      const all = await trust.getEvidenceTimeline(ref(t), { limit: 100 });
      // Newest-first ordering.
      for (let i = 1; i < all.length; i++) {
        expect(all[i - 1]!.occurred_at.getTime()).toBeGreaterThanOrEqual(all[i]!.occurred_at.getTime());
      }
      // The gap's lifecycle is present: a CREATED and a SUPERSEDED event both exist.
      const types = all.map((e) => e.event_type);
      expect(types).toContain('CREATED');
      expect(types).toContain('SUPERSEDED');

      // Keyset stability: page 1 then page 2 (before the last of page 1) never overlap.
      const page1 = await trust.getEvidenceTimeline(ref(t), { limit: 3 });
      expect(page1.length).toBe(3);
      const cursor = page1[page1.length - 1]!;
      const page2 = await trust.getEvidenceTimeline(ref(t), {
        limit: 3,
        before: { occurred_at: cursor.occurred_at, id: cursor.id },
      });
      const p1ids = new Set(page1.map((e) => e.id));
      expect(page2.every((e) => !p1ids.has(e.id))).toBe(true);
    });

    // ---- (c) merge-history: both roles ----

    it('(c) listCompletedMergeOperationsForSubject returns a subject in either role', async () => {
      const tP = uuidv7();
      const tQ = uuidv7();
      const tR = uuidv7();
      await seedEmployment({ talentId: tP, employer: 'p', start: '2020-01-01', end: '2020-12-31', srcId: 'p1' });
      await seedEmployment({ talentId: tQ, employer: 'q', start: '2020-01-01', end: '2020-12-31', srcId: 'q1' });
      await seedEmployment({ talentId: tR, employer: 'r', start: '2020-01-01', end: '2020-12-31', srcId: 'r1' });
      const [P, Q, R] = [await subjectIdFor(tP), await subjectIdFor(tQ), await subjectIdFor(tR)];
      await mergeAndComplete(P, Q); // P survivor, Q merged
      await mergeAndComplete(P, R); // P survivor, R merged

      const forP = await repo.listCompletedMergeOperationsForSubject(TENANT, P);
      expect(forP).toHaveLength(2); // survivor role, both ops
      expect(forP.every((o) => o.status === 'COMPLETED')).toBe(true);
      const forQ = await repo.listCompletedMergeOperationsForSubject(TENANT, Q);
      expect(forQ).toHaveLength(1); // merged role
      expect(forQ[0]!.merged_subject_id).toBe(Q);
    });

    // ---- (d) one story: bands and evidence from the SAME cluster-union ----

    it('(d) getSubjectDetail evidence goes cluster-union (pre-fix single-subject divergence, now fixed)', async () => {
      const tA = uuidv7();
      const tB = uuidv7();
      const e1 = await seedEmployment({ talentId: tA, employer: 'acme', start: '2020-01-01', end: '2020-12-31', srcId: 'a1' });
      const e2 = await seedEmployment({ talentId: tB, employer: 'globex', start: '2018-01-01', end: '2019-12-31', srcId: 'b1' });
      const sidA = await subjectIdFor(tA);
      const sidB = await subjectIdFor(tB);
      await mergeAndComplete(sidA, sidB);
      await trust.recomputeTrustState(sidA, TENANT); // bands now over the union [A,B]

      // Pre-fix path (single-subject) sees only A's evidence — the divergence.
      const singleSubject = await repo.listEvidenceBySubject(sidA);
      expect(singleSubject.map((e) => e.id)).toEqual([e1]);

      // The fixed detail read derives evidence from the SAME union the bands did.
      const detail = await sourcing.getSubjectDetail(TENANT, sidA);
      expect(detail.evidence.map((e) => e.id).sort()).toEqual([e1, e2].sort());
    });

    // ---- (e) the strip: strength off the sourcing wire ----

    it('(e) getSubjectDetail evidence rows carry no strength (stripped)', async () => {
      const t = uuidv7();
      await seedEmployment({ talentId: t, employer: 'acme', start: '2020-01-01', end: '2020-12-31', srcId: 'a1' });
      const sid = await subjectIdFor(t);
      const detail = await sourcing.getSubjectDetail(TENANT, sid);
      expect(detail.evidence.length).toBeGreaterThan(0);
      for (const row of detail.evidence) {
        expect('strength' in row).toBe(false);
      }
    });
  },
);
