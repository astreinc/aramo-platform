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
import { TalentTrustService } from '@aramo/talent-trust';

import { AppModule } from '../app.module.js';
import { ConsistencyService } from '../talent-identity/consistency.service.js';

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
].map(M);

const TENANT = '01900000-0000-7000-8000-0000000000c1';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-5 B2 — earned continuity + named thinness (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let db: Client;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let trust: TalentTrustService;
    let consistency: ConsistencyService;

    const DAY = 24 * 60 * 60 * 1000;
    const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY);

    // One IDENTITY contact observation. Distinct source_ref = a distinct arrival;
    // collected_at is the arrival time. recordEvidence writes it raw (no anchor
    // dedupe), so two same-value rows across time coexist in the cluster-union.
    async function seedContact(args: {
      talentId: string;
      value?: string;
      kind?: 'EMAIL' | 'PHONE';
      collectedAt: Date;
      srcId: string;
      sourceClass?: 'SELF' | 'THIRD_PARTY_UNVERIFIED' | 'THIRD_PARTY_VERIFIED';
    }): Promise<void> {
      await trust.recordEvidence({
        subjectRef: { tenant_id: TENANT, ref_type: 'ATS_TALENT_RECORD', ref_id: args.talentId },
        dimension: 'IDENTITY',
        assertion_type: args.kind ?? 'EMAIL',
        assertion_payload: { value: args.value ?? 'ada@x.com', raw_source: 'test' },
        source_class: args.sourceClass ?? 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        source_ref: { talent_evidence_id: args.srcId },
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        collected_at: args.collectedAt,
        created_by: 'test',
      });
    }

    async function seedEmployment(args: {
      talentId: string;
      employer: string;
      start: string | null;
      end: string | null;
      srcId: string;
      sourceClass?: 'SELF' | 'THIRD_PARTY_UNVERIFIED' | 'THIRD_PARTY_VERIFIED';
    }): Promise<void> {
      await trust.recordEvidence({
        subjectRef: { tenant_id: TENANT, ref_type: 'ATS_TALENT_RECORD', ref_id: args.talentId },
        dimension: 'CLAIMS',
        assertion_type: 'EMPLOYMENT',
        assertion_payload: {
          employer_raw: args.employer,
          role_title_raw: 'Engineer',
          ...(args.start !== null ? { start_date_raw: args.start } : {}),
          ...(args.end !== null ? { end_date_raw: args.end } : {}),
        },
        source_class: args.sourceClass ?? 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        source_ref: { talent_evidence_id: args.srcId },
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        created_by: 'test',
      });
    }

    async function subjectIdFor(talentId: string): Promise<string> {
      const s = await trust.resolveSubjectRef({ tenant_id: TENANT, ref_type: 'ATS_TALENT_RECORD', ref_id: talentId });
      return s!.id;
    }

    async function derived(subjectId: string, assertionType: string): Promise<Array<{ id: string; current_status: string; source_class: string; payload: Record<string, unknown> }>> {
      const r = await db.query<{ id: string; current_status: string; source_class: string; assertion_payload: Record<string, unknown> }>(
        `SELECT id, current_status, source_class, assertion_payload
           FROM talent_trust."EvidenceRecord"
          WHERE subject_id = $1::uuid AND assertion_type = $2 AND dimension = 'CONTINUITY'`,
        [subjectId, assertionType],
      );
      return r.rows.map((x) => ({ id: x.id, current_status: x.current_status, source_class: x.source_class, payload: x.assertion_payload }));
    }
    const validRows = <T extends { current_status: string }>(rows: T[]): T[] => rows.filter((x) => x.current_status === 'VALID');

    async function flagsOf(subjectId: string): Promise<{ single_source_only: boolean; longitudinal_observed: boolean; continuity_band: string }> {
      const r = await db.query<{ single_source_only: boolean; longitudinal_observed: boolean; continuity_band: string }>(
        `SELECT single_source_only, longitudinal_observed, continuity_band FROM talent_trust."TrustState" WHERE subject_id = $1::uuid`,
        [subjectId],
      );
      return r.rows[0]!;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await db.query(`INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid, 'TR5B2', now()) ON CONFLICT DO NOTHING`, [TENANT]);
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'core') ON CONFLICT DO NOTHING`, [TENANT]);

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['MAILER_PROVIDER'] = process.env['MAILER_PROVIDER'];
      process.env['DATABASE_URL'] = url;
      process.env['MAILER_PROVIDER'] = 'stub';

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await module.init();
      trust = module.get(TalentTrustService);
      consistency = module.get(ConsistencyService);
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
      for (const t of ['EvidenceLink', 'EvidenceEvent', 'EvidenceRecord', 'TrustState', 'ResolutionSubjectRef', 'ResolutionSubject']) {
        await db.query(`TRUNCATE TABLE talent_trust."${t}" CASCADE`);
      }
    });

    // ---- (a) LONGITUDINAL_PRESENCE both ways --------------------------------

    it('(a) LONGITUDINAL_PRESENCE fires on ≥2 arrivals ≥30d apart; silent on a single arrival', async () => {
      const t = uuidv7();
      await seedContact({ talentId: t, collectedAt: daysAgo(120), srcId: 'o1', sourceClass: 'THIRD_PARTY_UNVERIFIED' });
      await seedContact({ talentId: t, collectedAt: daysAgo(30), srcId: 'o2', sourceClass: 'THIRD_PARTY_VERIFIED' });
      const sid = await subjectIdFor(t);

      await trust.runConsistencyForSubject(TENANT, sid);
      const lp = validRows(await derived(sid, 'LONGITUDINAL_PRESENCE'));
      expect(lp).toHaveLength(1);
      // (b) class-floor: derived class is the FLOOR of inputs, not the higher one.
      expect(lp[0]!.source_class).toBe('THIRD_PARTY_UNVERIFIED');
      expect(lp[0]!.payload['observation_count']).toBe(2);

      // single arrival → silent
      const t2 = uuidv7();
      await seedContact({ talentId: t2, collectedAt: daysAgo(30), srcId: 'x1' });
      const sid2 = await subjectIdFor(t2);
      await trust.runConsistencyForSubject(TENANT, sid2);
      expect(validRows(await derived(sid2, 'LONGITUDINAL_PRESENCE'))).toHaveLength(0);
    });

    // ---- (a) HISTORY_SPAN both ways -----------------------------------------

    it('(a) HISTORY_SPAN fires on ≥24mo fully-dated + no gaps; silent on sub-span / undated', async () => {
      const t = uuidv7();
      await seedEmployment({ talentId: t, employer: 'acme', start: '2019-01-01', end: '2020-12-31', srcId: 'j1', sourceClass: 'THIRD_PARTY_VERIFIED' });
      await seedEmployment({ talentId: t, employer: 'acme', start: '2021-01-01', end: '2022-06-30', srcId: 'j2', sourceClass: 'SELF' });
      const sid = await subjectIdFor(t);
      await trust.runConsistencyForSubject(TENANT, sid);
      const hs = validRows(await derived(sid, 'HISTORY_SPAN'));
      expect(hs).toHaveLength(1);
      expect(hs[0]!.source_class).toBe('SELF'); // (b) FLOOR
      expect(Number(hs[0]!.payload['span_months'])).toBeGreaterThanOrEqual(24);
      expect(hs[0]!.payload['open_gap_count']).toBe(0);

      // undated → silent
      const t2 = uuidv7();
      await seedEmployment({ talentId: t2, employer: 'acme', start: '2018-01-01', end: '2022-01-01', srcId: 'a' });
      await seedEmployment({ talentId: t2, employer: 'globex', start: null, end: null, srcId: 'b' });
      const sid2 = await subjectIdFor(t2);
      await trust.runConsistencyForSubject(TENANT, sid2);
      expect(validRows(await derived(sid2, 'HISTORY_SPAN'))).toHaveLength(0);
    });

    // ---- (c) supersede-replace both directions ------------------------------

    it('(c) a grown observation basis REPLACES; a newly-opened gap SUPERSEDES the span', async () => {
      const t = uuidv7();
      await seedContact({ talentId: t, collectedAt: daysAgo(120), srcId: 'o1' });
      await seedContact({ talentId: t, collectedAt: daysAgo(60), srcId: 'o2' });
      const sid = await subjectIdFor(t);
      await trust.runConsistencyForSubject(TENANT, sid);
      const first = validRows(await derived(sid, 'LONGITUDINAL_PRESENCE'));
      expect(first).toHaveLength(1);

      // a third arrival → the current row is superseded, exactly one VALID remains.
      await seedContact({ talentId: t, collectedAt: daysAgo(10), srcId: 'o3' });
      await trust.runConsistencyForSubject(TENANT, sid);
      const all = await derived(sid, 'LONGITUDINAL_PRESENCE');
      expect(validRows(all)).toHaveLength(1); // singular current truth
      expect(all.filter((r) => r.current_status === 'SUPERSEDED')).toHaveLength(1);
      expect(validRows(all)[0]!.payload['observation_count']).toBe(3);

      // HISTORY_SPAN: build a clean span, then open an interior gap under it.
      const e = uuidv7();
      await seedEmployment({ talentId: e, employer: 'acme', start: '2016-01-01', end: '2019-01-01', srcId: 's1' });
      await seedEmployment({ talentId: e, employer: 'acme', start: '2019-01-15', end: '2021-06-30', srcId: 's2' });
      const esid = await subjectIdFor(e);
      await trust.runConsistencyForSubject(TENANT, esid);
      expect(validRows(await derived(esid, 'HISTORY_SPAN'))).toHaveLength(1);
      // a far-later job leaves a >180d interior gap → the detector opens a gap →
      // the span's basis breaks → it is superseded without replacement.
      await seedEmployment({ talentId: e, employer: 'globex', start: '2023-01-01', end: '2024-01-01', srcId: 's3' });
      await trust.runConsistencyForSubject(TENANT, esid);
      expect(validRows(await derived(esid, 'HISTORY_SPAN'))).toHaveLength(0); // retired
    });

    // ---- (d) both flags flip both ways --------------------------------------

    it('(d) single_source_only clears on a 2nd independent source; longitudinal_observed sets then clears', async () => {
      const t = uuidv7();
      await seedContact({ talentId: t, value: 'ada@x.com', collectedAt: daysAgo(120), srcId: 'o1' });
      await seedContact({ talentId: t, value: 'ada@x.com', collectedAt: daysAgo(30), srcId: 'o1' }); // SAME source_ref → one group
      const sid = await subjectIdFor(t);
      await trust.runConsistencyForSubject(TENANT, sid);
      let f = await flagsOf(sid);
      expect(f.single_source_only).toBe(true); // one independence group
      expect(f.longitudinal_observed).toBe(true); // LP fired

      // a second INDEPENDENT source (distinct source_ref) → single_source_only clears.
      await seedContact({ talentId: t, value: 'ada@x.com', collectedAt: daysAgo(20), srcId: 'other-src' });
      await trust.runConsistencyForSubject(TENANT, sid);
      f = await flagsOf(sid);
      expect(f.single_source_only).toBe(false);

      // longitudinal_observed clears when the LP row is retired without replacement.
      // Supersede the two same-value observations' basis by contradicting them, so
      // no ≥2 VALID same-value group remains.
      const contactIds = await db.query<{ id: string }>(
        `SELECT id FROM talent_trust."EvidenceRecord" WHERE subject_id = $1::uuid AND assertion_type = 'EMAIL'`,
        [sid],
      );
      for (const row of contactIds.rows.slice(1)) {
        await trust.contradictRecord(row.id, 'TEST_RETIRE');
      }
      await trust.runConsistencyForSubject(TENANT, sid);
      f = await flagsOf(sid);
      expect(f.longitudinal_observed).toBe(false);
      expect(validRows(await derived(sid, 'LONGITUDINAL_PRESENCE'))).toHaveLength(0);
    });

    // ---- (e) the broadened gate ---------------------------------------------

    it('(e) IDENTITY-dimension new evidence now re-selects the subject (previously CLAIMS-only)', async () => {
      const t = uuidv7();
      // ONLY IDENTITY evidence — no CLAIMS at all. Under the old CLAIMS-only gate
      // this subject would never be selected by the poll.
      await seedContact({ talentId: t, collectedAt: daysAgo(120), srcId: 'o1' });
      await seedContact({ talentId: t, collectedAt: daysAgo(30), srcId: 'o2' });
      const sid = await subjectIdFor(t);

      const r = await consistency.drainBatch({ batchSize: 100 });
      expect(r.attempted).toBeGreaterThanOrEqual(1);
      // the broadened pass ran the derivers → LONGITUDINAL_PRESENCE landed.
      expect(validRows(await derived(sid, 'LONGITUDINAL_PRESENCE'))).toHaveLength(1);
      // watermark advanced → a second drain re-selects nothing.
      expect((await consistency.drainBatch({ batchSize: 100 })).attempted).toBe(0);
    });

    // ---- (g) the CONTINUITY ceiling holds -----------------------------------

    it('(g) with BOTH derived signals VALID, continuity_band reaches at most CORROBORATED', async () => {
      const t = uuidv7();
      await seedContact({ talentId: t, collectedAt: daysAgo(200), srcId: 'o1', sourceClass: 'THIRD_PARTY_VERIFIED' });
      await seedContact({ talentId: t, collectedAt: daysAgo(30), srcId: 'o2', sourceClass: 'THIRD_PARTY_VERIFIED' });
      await seedEmployment({ talentId: t, employer: 'acme', start: '2019-01-01', end: '2021-06-30', srcId: 'j1', sourceClass: 'THIRD_PARTY_VERIFIED' });
      const sid = await subjectIdFor(t);
      await trust.runConsistencyForSubject(TENANT, sid);
      expect(validRows(await derived(sid, 'LONGITUDINAL_PRESENCE'))).toHaveLength(1);
      const f = await flagsOf(sid);
      // AUTHORITATIVE_ASSERTION_TYPES.CONTINUITY is ∅ → the top two bands are
      // unreachable no matter how strong the derived inputs are.
      expect(['NOT_ESTABLISHED', 'SELF_ASSERTED', 'CORROBORATED']).toContain(f.continuity_band);
      expect(['INDEPENDENTLY_VERIFIED', 'AUTHORITATIVE']).not.toContain(f.continuity_band);
    });
  },
);
