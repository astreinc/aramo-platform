import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TalentTrustService } from '@aramo/talent-trust';

import { AppModule } from '../app.module.js';
import { RecomputeSweepService } from '../talent-identity/recompute-sweep.service.js';

const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);

// No new migration in T5-B1 — the sweep is time-driven on the existing
// TrustState.last_recomputed_at, and the gate's EXISTS leg rides the existing
// EvidenceRecord (tenant_id, subject_id) composite index. Same 18-migration
// list as TR-4 B3.
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

const TENANT = '01900000-0000-7000-8000-0000000000b1';
const TENANT2 = '01900000-0000-7000-8000-0000000000b2';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-5 B1 — the decay-recompute sweep (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let db: Client;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let trust: TalentTrustService;
    let sweep: RecomputeSweepService;

    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const daysAgo = (n: number): Date => new Date(Date.now() - n * MS_PER_DAY);

    // A single CLAIMS record. `collectedAt` is set at CREATION (EvidenceRecord
    // content is immutable — a DB trigger forbids aging it after the fact), so a
    // record born 1000d old with a FAST profile is already below the
    // CONTRIBUTION_FLOOR at now (0.24 base × 0.5^(1000/30) ≈ 0). decay_profile is
    // caller-chosen so DURABLE-only subjects (which can never drift) can be
    // exercised. recordEvidence recomputes → a TrustState row is born.
    async function seedClaim(args: {
      talentId: string;
      tenant?: string;
      decayProfile?: 'SLOW' | 'FAST' | 'DURABLE';
      collectedAt?: Date;
    }): Promise<void> {
      await trust.recordEvidence({
        subjectRef: {
          tenant_id: args.tenant ?? TENANT,
          ref_type: 'ATS_TALENT_RECORD',
          ref_id: args.talentId,
        },
        dimension: 'CLAIMS',
        assertion_type: 'EMPLOYMENT',
        assertion_payload: {
          employer_raw: 'acme',
          role_title_raw: 'Engineer',
          start_date_raw: '2020-01-01',
          end_date_raw: '2020-12-31',
        },
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        source_ref: { talent_evidence_id: `s-${args.talentId}` },
        portability_class: 'TENANT_ONLY',
        decay_profile: args.decayProfile ?? 'FAST',
        collected_at: args.collectedAt,
        created_by: 'test',
      });
    }

    async function subjectIdFor(talentId: string, tenant = TENANT): Promise<string> {
      const s = await trust.resolveSubjectRef({
        tenant_id: tenant,
        ref_type: 'ATS_TALENT_RECORD',
        ref_id: talentId,
      });
      return s!.id;
    }

    // The band this evidence earns when its strength is UN-decayed — read off a
    // fresh probe subject (collected_at = now). This is the honest stored band
    // "as of when the evidence still counted," used to construct the pre-sweep
    // dishonest state. TrustState is a mutable materialized projection (no
    // immutability trigger — upsertTrustState overwrites it).
    async function freshBand(): Promise<string> {
      const probe = uuidv7();
      await seedClaim({ talentId: probe, decayProfile: 'FAST', collectedAt: new Date() });
      return (await stateOf(await subjectIdFor(probe))).claims_band;
    }

    // Construct the pre-sweep dishonest state: stamp the stored band the evidence
    // earned when fresh, backdated `staleDays` — modelling a subject last
    // recomputed that long ago, whose evidence has since decayed under it.
    async function injectAgedState(subjectId: string, band: string, staleDays: number): Promise<void> {
      await db.query(
        `UPDATE talent_trust."TrustState"
            SET claims_band = $2, last_recomputed_at = now() - ($3 || ' days')::interval
          WHERE subject_id = $1::uuid`,
        [subjectId, band, String(staleDays)],
      );
    }

    // Backdate ONLY the stamp (leave the stored band as recorded) — for the
    // skip/isolation/scoping proofs, which turn on gate selection, not on a band move.
    async function ageTrustState(subjectId: string, days: number): Promise<void> {
      await db.query(
        `UPDATE talent_trust."TrustState"
            SET last_recomputed_at = now() - ($2 || ' days')::interval
          WHERE subject_id = $1::uuid`,
        [subjectId, String(days)],
      );
    }

    async function stateOf(subjectId: string): Promise<{
      claims_band: string;
      stale_evidence_count: number;
      last_recomputed_at: Date;
    }> {
      const r = await db.query<{
        claims_band: string;
        stale_evidence_count: number;
        last_recomputed_at: Date;
      }>(
        `SELECT claims_band, stale_evidence_count, last_recomputed_at
           FROM talent_trust."TrustState" WHERE subject_id = $1::uuid`,
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
      for (const t of [TENANT, TENANT2]) {
        await db.query(
          `INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid, 'TR5B1', now()) ON CONFLICT DO NOTHING`,
          [t],
        );
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'core') ON CONFLICT DO NOTHING`,
          [t],
        );
      }

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['MAILER_PROVIDER'] = process.env['MAILER_PROVIDER'];
      process.env['DATABASE_URL'] = url;
      process.env['MAILER_PROVIDER'] = 'stub';

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await module.init();
      trust = module.get(TalentTrustService);
      sweep = module.get(RecomputeSweepService);
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

    // ---- (a) the headline proof ---------------------------------------------

    it('(a) a decayed subject last recomputed 31d ago: the sweep moves its band — and only the sweep could have', async () => {
      const undecayed = await freshBand();
      expect(undecayed).not.toBe('NOT_ESTABLISHED');

      const talent = uuidv7();
      // Evidence born 1000d old → already below the floor at now (the record-time
      // recompute stored NOT_ESTABLISHED).
      await seedClaim({ talentId: talent, decayProfile: 'FAST', collectedAt: daysAgo(1000) });
      const sid = await subjectIdFor(talent);
      // Overwrite the stored state to the honest band as of 31d ago (when the
      // evidence still counted) — the dishonest, stale-high band the sweep exists
      // to correct. The ONLY write after this is the sweep's recompute.
      await injectAgedState(sid, undecayed, 31);

      const before = await stateOf(sid);
      expect(before.claims_band).not.toBe('NOT_ESTABLISHED'); // the stale, dishonest band

      const r = await sweep.drainBatch({ batchSize: 100 });
      expect(r.recomputed).toBe(1);

      const after = await stateOf(sid);
      expect(after.claims_band).toBe('NOT_ESTABLISHED'); // decay finally priced
      expect(after.claims_band).not.toBe(before.claims_band); // the band demonstrably moved
      expect(after.last_recomputed_at.getTime()).toBeGreaterThan(before.last_recomputed_at.getTime());
    });

    // ---- (b) the three skip-proofs ------------------------------------------

    it('(b1) a DURABLE-only subject is never selected — it cannot drift', async () => {
      const talent = uuidv7();
      await seedClaim({ talentId: talent, decayProfile: 'DURABLE', collectedAt: daysAgo(1000) });
      const sid = await subjectIdFor(talent);
      await ageTrustState(sid, 31);
      const before = await stateOf(sid);

      const r = await sweep.drainBatch({ batchSize: 100 });
      expect(r.attempted).toBe(0); // gate's EXISTS leg excludes DURABLE-only

      const after = await stateOf(sid);
      expect(after.last_recomputed_at.getTime()).toBe(before.last_recomputed_at.getTime()); // untouched
    });

    it('(b2) a subject recomputed 29d ago is not selected — not yet stale', async () => {
      const talent = uuidv7();
      await seedClaim({ talentId: talent, decayProfile: 'FAST', collectedAt: daysAgo(1000) });
      const sid = await subjectIdFor(talent);
      await ageTrustState(sid, 29); // inside the 30d threshold
      const before = await stateOf(sid);

      const r = await sweep.drainBatch({ batchSize: 100 });
      expect(r.attempted).toBe(0);

      const after = await stateOf(sid);
      expect(after.last_recomputed_at.getTime()).toBe(before.last_recomputed_at.getTime());
    });

    it('(b3) the selection is idempotent: a swept subject leaves the gate', async () => {
      const talent = uuidv7();
      await seedClaim({ talentId: talent, decayProfile: 'FAST', collectedAt: daysAgo(1000) });
      const sid = await subjectIdFor(talent);
      await ageTrustState(sid, 31);

      const first = await sweep.drainBatch({ batchSize: 100 });
      expect(first.recomputed).toBe(1);
      // The recompute advanced last_recomputed_at to now → the subject no longer
      // satisfies (< now − 30d). No watermark column; time-driven idempotence.
      const second = await sweep.drainBatch({ batchSize: 100 });
      expect(second.attempted).toBe(0);
    });

    // ---- (c) stale_evidence_count under the floor crossing -------------------

    // NOTE (§2 finding, surfaced for the Lead): the directive's §5(c) —
    // "stale_evidence_count moves with the sweep where decay crossed the floor" —
    // is not satisfiable as literally written against this substrate.
    // stale_evidence_count counts current_status = 'STALE' rows (band-derivation),
    // and NOTHING sets STALE: markStale is landed-cold and §1 forbids calling it.
    // Decay crossing the floor moves the BAND (via the contributing-filter — test
    // (a)), never the STALE count. The substrate-true realization: the sweep's
    // recompute re-derives stale_evidence_count honestly (it stays 0 — the sweep
    // invents no staleness), while the floor crossing surfaces as the band move.
    it('(c) the sweep re-prices the floor crossing as a band move; stale_evidence_count stays honestly 0 (markStale landed-cold)', async () => {
      const undecayed = await freshBand();
      const talent = uuidv7();
      await seedClaim({ talentId: talent, decayProfile: 'FAST', collectedAt: daysAgo(1000) });
      const sid = await subjectIdFor(talent);
      await injectAgedState(sid, undecayed, 31);

      const before = await stateOf(sid);
      expect(before.stale_evidence_count).toBe(0);

      await sweep.drainBatch({ batchSize: 100 });

      const after = await stateOf(sid);
      expect(after.claims_band).toBe('NOT_ESTABLISHED'); // the floor crossing, priced as the band
      expect(after.stale_evidence_count).toBe(0); // recomputed honestly — no STALE status was set
    });

    // ---- (d) per-item isolation ---------------------------------------------

    it('(d) one poisoned subject fails loudly; the batch completes for the rest', async () => {
      const healthy = uuidv7();
      const poison = uuidv7();
      await seedClaim({ talentId: healthy, decayProfile: 'FAST', collectedAt: daysAgo(1000) });
      await seedClaim({ talentId: poison, decayProfile: 'FAST', collectedAt: daysAgo(1000) });
      const healthySid = await subjectIdFor(healthy);
      const poisonSid = await subjectIdFor(poison);
      for (const sid of [healthySid, poisonSid]) {
        await ageTrustState(sid, 31);
      }
      const poisonBefore = await stateOf(poisonSid);

      // Poison exactly one subject's recompute; pass the rest through.
      const original = trust.recomputeTrustState.bind(trust);
      const spy = vi
        .spyOn(trust, 'recomputeTrustState')
        .mockImplementation(async (subjectId: string, tenantId: string) => {
          if (subjectId === poisonSid) throw new Error('boom — poisoned recompute');
          return original(subjectId, tenantId);
        });
      try {
        const r = await sweep.drainBatch({ batchSize: 100 });
        expect(r.attempted).toBe(2);
        expect(r.recomputed).toBe(1); // the healthy one completed
        expect(r.failed).toBe(1); // the poisoned one failed loudly, did not abort the batch
      } finally {
        spy.mockRestore();
      }

      // The healthy subject was recomputed — its stamp advanced past the backdated value.
      const healthyAfter = await stateOf(healthySid);
      expect(healthyAfter.last_recomputed_at.getTime()).toBeGreaterThan(
        poisonBefore.last_recomputed_at.getTime(),
      );
      // The poisoned subject was left un-advanced — so the next tick re-selects it,
      // exactly as loud isolation intends (the failure never silently drops it).
      expect((await stateOf(poisonSid)).last_recomputed_at.getTime()).toBe(
        poisonBefore.last_recomputed_at.getTime(),
      );
    });

    // ---- (e) CLI counts + tenant scoping ------------------------------------

    it('(e) runToCompletion scopes to one tenant and reports counts; other tenants untouched', async () => {
      const t1 = uuidv7();
      const t2 = uuidv7();
      await seedClaim({ talentId: t1, tenant: TENANT, decayProfile: 'FAST' });
      await seedClaim({ talentId: t2, tenant: TENANT2, decayProfile: 'FAST' });
      const sid1 = await subjectIdFor(t1, TENANT);
      const sid2 = await subjectIdFor(t2, TENANT2);
      for (const sid of [sid1, sid2]) {
        await ageTrustState(sid, 31);
      }
      const t1Before = await stateOf(sid1);
      const t2Before = await stateOf(sid2);

      const result = await sweep.runToCompletion(TENANT);
      expect(result.recomputed).toBe(1); // only TENANT's subject
      expect(result.failed).toBe(0);

      expect((await stateOf(sid1)).last_recomputed_at.getTime()).toBeGreaterThan(
        t1Before.last_recomputed_at.getTime(),
      ); // TENANT re-priced
      expect((await stateOf(sid2)).last_recomputed_at.getTime()).toBe(
        t2Before.last_recomputed_at.getTime(),
      ); // TENANT2 untouched by the scoped run
    });

    // ---- (f) regression guard: a fresh subject is never spuriously swept -----

    it('(f) a freshly-recomputed subject is left alone (no spurious write)', async () => {
      const talent = uuidv7();
      await seedClaim({ talentId: talent, decayProfile: 'FAST' });
      const sid = await subjectIdFor(talent);
      // last_recomputed_at is now (recordEvidence just recomputed); no ageing.
      const before = await stateOf(sid);

      const r = await sweep.drainBatch({ batchSize: 100 });
      expect(r.attempted).toBe(0); // not yet stale

      const after = await stateOf(sid);
      expect(after.last_recomputed_at.getTime()).toBe(before.last_recomputed_at.getTime());
    });
  },
);
