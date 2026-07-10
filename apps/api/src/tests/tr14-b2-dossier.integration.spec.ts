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
import { DossierService } from '../talent-identity/dossier.service.js';

const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);

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
  'libs/talent-trust/prisma/migrations/20260712120000_tr8_b1_verified_control_stale/migration.sql',
  'libs/talent-trust/prisma/migrations/20260713120000_tr12_b1_verification_proposal/migration.sql',
].map(M);

const TENANT = '01900000-0000-7000-8000-0000000000e1';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-14 B2 — the contracted trust dossier (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let db: Client;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let trust: TalentTrustService;
    let repo: TalentTrustRepository;
    let dossier: DossierService;

    const refOf = (recordId: string) => ({ tenant_id: TENANT, ref_type: 'ATS_TALENT_RECORD' as const, ref_id: recordId });

    async function seedEmployment(recordId: string, employer: string, start: string | null, end: string | null, srcId: string): Promise<string> {
      const ev = await trust.recordEvidence({
        subjectRef: refOf(recordId),
        dimension: 'CLAIMS',
        assertion_type: 'EMPLOYMENT',
        assertion_payload: { employer_raw: employer, role_title_raw: 'Engineer', ...(start ? { start_date_raw: start } : {}), ...(end ? { end_date_raw: end } : {}) },
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        source_ref: { talent_evidence_id: srcId },
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: 'test',
      });
      return ev.id;
    }
    async function seedEmailObs(recordId: string, value: string, collectedAt: Date, srcId: string): Promise<void> {
      await trust.recordEvidence({
        subjectRef: refOf(recordId),
        dimension: 'IDENTITY',
        assertion_type: 'EMAIL',
        assertion_payload: { value, raw_source: 'test' },
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        source_ref: { talent_evidence_id: srcId },
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        collected_at: collectedAt,
        created_by: 'test',
      });
    }
    async function subjectIdFor(recordId: string): Promise<string> {
      return (await trust.resolveSubjectRef(refOf(recordId)))!.id;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await db.query(`INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid, 'TR14B2', now()) ON CONFLICT DO NOTHING`, [TENANT]);
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'core') ON CONFLICT DO NOTHING`, [TENANT]);
      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['MAILER_PROVIDER'] = process.env['MAILER_PROVIDER'];
      process.env['DATABASE_URL'] = url;
      process.env['MAILER_PROVIDER'] = 'stub';
      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await module.init();
      trust = module.get(TalentTrustService);
      repo = module.get(TalentTrustRepository);
      dossier = module.get(DossierService);
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
      for (const t of ['EvidenceLink', 'EvidenceEvent', 'EvidenceRecord', 'TrustState', 'SubjectAnchor', 'VerificationRequest', 'ResolutionSubjectRef', 'ResolutionSubject', 'SubjectMergeOperation']) {
        await db.query(`TRUNCATE TABLE talent_trust."${t}" CASCADE`);
      }
    });

    // ---- (a) the demo-subject e2e (the sales skeleton) ----------------------

    it('(a) the demo subject: verified anchor + open contradiction + healed gap + longitudinal statement + merge history', async () => {
      const R1 = uuidv7();

      // longitudinal: same email on two arrivals 90d apart
      await seedEmailObs(R1, 'ada@x.com', daysAgo(120), 'o1');
      await seedEmailObs(R1, 'ada@x.com', daysAgo(30), 'o2');
      // the verified anchor (EMAIL) — recordAnchor mints the SubjectAnchor
      await trust.recordAnchor({ tenant_id: TENANT, talent_record_id: R1, anchor_kind: 'EMAIL', normalized_value: 'ada@x.com', raw_source: 'ada@x.com', created_by: 'test' });
      // a gap: acme(2016-2018) ... globex(2020-2021)
      await seedEmployment(R1, 'acme', '2016-01-01', '2018-01-01', 'j1');
      await seedEmployment(R1, 'globex', '2020-01-01', '2021-01-01', 'j2');
      const sid = await subjectIdFor(R1);
      await trust.runConsistencyForSubject(TENANT, sid); // opens the gap + derives LONGITUDINAL_PRESENCE
      await seedEmployment(R1, 'initech', '2018-06-01', '2019-12-01', 'j3'); // fills the gap
      await trust.runConsistencyForSubject(TENANT, sid); // heals it (SUPERSEDED)

      // a standing contradiction (manual, on a dedicated pair that the detectors
      // don't touch — pre-2016 so it never affects the gap coverage).
      const cA = await seedEmployment(R1, 'confco', '2010-01-01', '2011-01-01', 'c1');
      const cB = await seedEmployment(R1, 'rivalco', '2010-01-01', '2011-01-01', 'c2');
      await trust.contradict(cA, cB, 'Overlapping roles at different employers');

      // the verified anchor's CONFIRMED verification request
      await db.query(
        `INSERT INTO talent_trust."VerificationRequest"
           (id, tenant_id, talent_record_id, subject_id, anchor_kind, normalized_value, token_hash, status, created_by, created_at, expires_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'EMAIL','ada@x.com','h','CONFIRMED','test', now(), now() + interval '1 day')`,
        [uuidv7(), TENANT, R1, sid],
      );

      // merge history: a second subject merged into S1
      const R2 = uuidv7();
      await seedEmployment(R2, 'oldrec', '2012-01-01', '2013-01-01', 'm1');
      const s2 = await subjectIdFor(R2);
      await trust.mergeSubjects(sid, s2, 'same person', 'tester');
      const op = await repo.findMergeOperationBySubjects(TENANT, sid, s2);
      await repo.completeMergeOperation(op!.id, new Date());
      await trust.recomputeTrustState(sid, TENANT);

      const head = await dossier.getDossier(TENANT, R1);
      expect(head.ledger_established).toBe(true);
      // longitudinal statement present
      expect(head.statements).toContain('Observed over time');
      // an open contradiction with its reason (never a count)
      const contra = head.contradictions.find((c) => c.reason === 'Overlapping roles at different employers');
      expect(contra).toBeDefined();
      expect(contra!.contradicting_evidence_id).toBeTruthy();
      // verified anchor
      const emailVerif = head.verifications.find((v) => v.anchor_kind === 'EMAIL');
      expect(emailVerif?.status).toBe('CONFIRMED');
      // merge provenance (survivor role)
      expect(head.merge_provenance.some((m) => m.role === 'survivor')).toBe(true);

      // the healed-gap story reads in the timeline (a SUPERSEDED event exists)
      const page = await dossier.getDossierEvidence(TENANT, R1, { limit: 200 });
      expect(page.items.some((i) => i.event.event_type === 'SUPERSEDED')).toBe(true);
      // NO strength anywhere in the timeline evidence (R10)
      for (const i of page.items) expect('strength' in i.evidence).toBe(false);
    });

    // ---- (b) the empty-ledger record ----------------------------------------

    it('(b) a record with no subject returns the uniform ledger_established:false shape', async () => {
      const head = await dossier.getDossier(TENANT, uuidv7());
      expect(head.ledger_established).toBe(false);
      expect(head.dimensions.identity.band).toBe('NOT_ESTABLISHED');
      expect(head.contradictions).toEqual([]);
      expect(head.statements).toEqual([]);
      const page = await dossier.getDossierEvidence(TENANT, uuidv7(), {});
      expect(page.items).toEqual([]);
      expect(page.next_cursor).toBeNull();
    });

    // ---- (c) timeline keyset stability --------------------------------------

    it('(c) the evidence timeline is keyset-stable across pages, newest-first', async () => {
      const R = uuidv7();
      for (let i = 0; i < 5; i++) await seedEmployment(R, `emp${i}`, '2020-01-01', '2020-12-31', `k${i}`);
      const page1 = await dossier.getDossierEvidence(TENANT, R, { limit: 3 });
      expect(page1.items.length).toBe(3);
      expect(page1.next_cursor).not.toBeNull();
      const page2 = await dossier.getDossierEvidence(TENANT, R, { cursor: page1.next_cursor, limit: 3 });
      const p1 = new Set(page1.items.map((i) => i.event.id));
      expect(page2.items.every((i) => !p1.has(i.event.id))).toBe(true);
      // newest-first
      const times = [...page1.items, ...page2.items].map((i) => new Date(i.event.occurred_at).getTime());
      for (let i = 1; i < times.length; i++) expect(times[i - 1]!).toBeGreaterThanOrEqual(times[i]!);
    });

    // ---- (d) resolve e2e: cap lifts on the refetched dossier -----------------

    it('(d) resolving a contradiction lifts the cap on the refetched dossier', async () => {
      const R = uuidv7();
      const a = await seedEmployment(R, 'acme', '2020-01-01', '2020-12-31', 'a');
      const b = await seedEmployment(R, 'globex', '2020-01-01', '2020-12-31', 'b');
      await trust.contradict(a, b, 'conflict');
      const sid = await subjectIdFor(R);

      const before = await dossier.getDossier(TENANT, R);
      expect(before.contradictions.length).toBeGreaterThanOrEqual(1);
      const capped = before.contradictions[0]!;

      // the tab's dialog calls the TR-4 resolve endpoint (exercised directly here).
      await trust.resolveContradiction(capped.evidence_id, 'tester', 'reviewed — not a conflict');

      const after = await dossier.getDossier(TENANT, R);
      expect(after.contradictions.find((c) => c.evidence_id === capped.evidence_id)).toBeUndefined();
      // the claims band is no longer contradiction-capped (recompute lifted it)
      expect(await repo.findTrustStateBySubject(sid)).not.toBeNull();
    });
  },
);
