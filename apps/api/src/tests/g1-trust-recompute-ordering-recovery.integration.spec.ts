import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvidenceRecordRow, TrustStateDerived } from '@aramo/talent-trust';

import { RecomputeRepairService } from '../talent-identity/recompute-repair.service.js';

import { startTrustTenantHarness, type TrustTenantHarness } from './support/trust-tenant-isolation-harness.js';

// G1 — TrustState recompute ordering and recovery (canonical directive
// Aramo-G1-TrustState-Recompute-Ordering-and-Recovery-Directive-v1_0-LOCKED §6).
// Real PostgreSQL. Concurrency is made DETERMINISTIC by pausing a recompute inside
// its locked transaction (between the snapshot read and the TrustState write) via
// an async `derive`, then racing the competing operation against it.

const TENANT_A = '01900000-0000-7000-8000-00000007a001';
const TENANT_B = '01900000-0000-7000-8000-00000007b002';
const ACTOR = '00000000-0000-7000-8000-00000007a0aa';

interface Gate {
  reached: Promise<void>;
  release: () => void;
  wait: () => Promise<void>;
}
function gate(): Gate {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const released = new Promise<void>((r) => (release = r));
  return { reached, release, wait: async () => { reach(); await released; } };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'G1 — TrustState recompute ordering & recovery (real Postgres)',
  () => {
    let h: TrustTenantHarness;
    let repair: RecomputeRepairService;

    beforeAll(async () => {
      h = await startTrustTenantHarness([TENANT_A, TENANT_B]);
      repair = h.module.get(RecomputeRepairService);
      // Test-only fault injection (disposable DB).
      await h.db.query(`
        CREATE TABLE public.g1_fail_subject (subject_id uuid PRIMARY KEY);
        CREATE OR REPLACE FUNCTION public.g1_trust_state_fault() RETURNS trigger AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM public.g1_fail_subject f WHERE f.subject_id = NEW.subject_id) THEN
            RAISE EXCEPTION 'g1 injected recompute fault';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER g1_trust_state_fault BEFORE INSERT OR UPDATE ON talent_trust."TrustState"
          FOR EACH ROW EXECUTE FUNCTION public.g1_trust_state_fault();
        CREATE OR REPLACE FUNCTION public.g1_event_fault() RETURNS trigger AS $$
        BEGIN
          IF NEW.actor = 'G1_FAULT' THEN RAISE EXCEPTION 'g1 injected event fault'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER g1_event_fault BEFORE INSERT ON talent_trust."EvidenceEvent"
          FOR EACH ROW EXECUTE FUNCTION public.g1_event_fault();
      `);
    }, 600_000);

    afterAll(async () => {
      await h?.close();
    }, 60_000);

    // ---- helpers -------------------------------------------------------------
    const subjectOf = async (tenant: string, talent: string): Promise<string> =>
      (await h.trust.resolveSubjectRef(h.refFor(tenant, talent)))!.id;
    const trustRow = async (subjectId: string): Promise<Record<string, unknown> | undefined> => {
      const r = await h.db.query(`SELECT * FROM talent_trust."TrustState" WHERE subject_id = $1::uuid`, [subjectId]);
      if (r.rows.length === 0) return undefined;
      const { last_recomputed_at: _ignored, ...rest } = r.rows[0] as Record<string, unknown>;
      return rest;
    };
    const requestOf = async (subjectId: string): Promise<Date | null> =>
      ((await h.db.query(`SELECT trust_recompute_requested_at AS r FROM talent_trust."ResolutionSubject" WHERE id = $1::uuid`, [subjectId]))
        .rows[0] as { r: Date | null }).r;
    const failSubject = (s: string) => h.db.query(`INSERT INTO public.g1_fail_subject (subject_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING`, [s]);
    const healAll = () => h.db.query(`DELETE FROM public.g1_fail_subject`);
    // The state a FRESH, serialized derivation produces from the committed ledger.
    const freshDerivation = async (subjectId: string, tenant: string): Promise<Record<string, unknown> | undefined> => {
      await h.trust.recomputeTrustState(subjectId, tenant);
      return trustRow(subjectId);
    };
    const pausedRecompute = (subjectId: string, tenant: string, g: Gate): Promise<unknown> => {
      // The real service projection: recompute via the service once to learn the
      // shape, then reuse deriveTrustState through the repository with a pause.
      return h.repo.recomputeUnderLock({
        subject_id: subjectId,
        tenant_id: tenant,
        now: new Date(),
        derive: async (evidence: EvidenceRecordRow[]): Promise<TrustStateDerived> => {
          const snapshot = evidence.map((e) => e.current_status);
          await g.wait(); // paused INSIDE the locked transaction, after the snapshot read
          return snapshotDerived(snapshot);
        },
      });
    };
    // A deliberately "stale-capable" projection: open_contradiction_count from the
    // snapshot the recompute READ (so an older snapshot is observable if written last).
    const snapshotDerived = (statuses: string[]): TrustStateDerived => ({
      identity_band: 'NOT_ESTABLISHED',
      claims_band: 'NOT_ESTABLISHED',
      continuity_band: 'NOT_ESTABLISHED',
      eligibility_band: 'NOT_ESTABLISHED',
      open_contradiction_count: statuses.filter((s) => s === 'CONTRADICTED').length,
      stale_evidence_count: 0,
      has_open_dispute: false,
      single_source_only: false,
      longitudinal_observed: false,
      verified_control_stale: false,
    });

    // ---- 1. stale-overwrite reproduction + correction ------------------------
    it('1 — an older recompute cannot overwrite a newer one: the competing write waits for the lock holder', async () => {
      const talent = uuidv7();
      await h.seedEvidence(TENANT_A, talent);
      const ev2 = await h.seedEvidence(TENANT_A, talent);
      const subject = await subjectOf(TENANT_A, talent);
      const g = gate();
      const older = pausedRecompute(subject, TENANT_A, g); // reads the snapshot with 0 contradictions
      await g.reached;
      // The newer change: contradict ev2 (its tx must WAIT — the older recompute holds
      // the cluster's subject-row lock — so it cannot commit underneath the snapshot).
      let newerDone = false;
      const newer = h.trust.contradictRecord(TENANT_A, ev2, 'newer change').then(() => (newerDone = true));
      await new Promise((r) => setTimeout(r, 750));
      expect(newerDone).toBe(false); // serialized behind the older recompute
      g.release();
      await older;
      await newer;
      // The newer change's own recompute ran AFTER the older one → newest wins.
      const row = await trustRow(subject);
      expect(row?.['open_contradiction_count']).toBe(1);
      expect(row).toEqual(await freshDerivation(subject, TENANT_A));
    });

    // ---- 2. wrong-survivor reproduction + correction -------------------------
    it('2 — a change on merged-away-origin evidence recomputes the ACTIVE SURVIVOR; the loser row stays frozen', async () => {
      const tx = uuidv7();
      const ty = uuidv7();
      const evX = await h.seedEvidence(TENANT_A, tx);
      await h.seedEvidence(TENANT_A, ty);
      const x = await subjectOf(TENANT_A, tx);
      const y = await subjectOf(TENANT_A, ty);
      await h.trust.mergeSubjects(y, x, 'g1 test', ACTOR);
      await h.trust.recomputeTrustState(y, TENANT_A);
      const loserBefore = await trustRow(x);
      const survivorBefore = await trustRow(y);
      await h.trust.contradictRecord(TENANT_A, evX, 'x-origin change'); // recompute(ev.subject_id = x)
      const survivorAfter = await trustRow(y);
      expect(survivorAfter?.['open_contradiction_count']).toBe(Number(survivorBefore?.['open_contradiction_count'] ?? 0) + 1);
      expect(await trustRow(x)).toEqual(loserBefore); // frozen
    });

    // ---- 3. concurrent recomputes + lifecycle writes ------------------------
    it('3 — N concurrent lifecycle writes on one cluster converge to a fresh derivation', async () => {
      const talent = uuidv7();
      // Seeded sequentially: concurrent FIRST-arrival subject creation is a separate,
      // pre-existing race (resolveOrCreateSubject), outside G1's scope.
      const evs: string[] = [];
      for (let i = 0; i < 6; i += 1) evs.push(await h.seedEvidence(TENANT_A, talent));
      const subject = await subjectOf(TENANT_A, talent);
      await Promise.all([
        ...evs.slice(0, 3).map((e) => h.trust.contradictRecord(TENANT_A, e, 'concurrent')),
        ...evs.slice(3).map((e) => h.trust.markStale(TENANT_A, e)),
        h.trust.recomputeTrustState(subject, TENANT_A),
        h.trust.recomputeTrustState(subject, TENANT_A),
      ]);
      const settled = await trustRow(subject);
      expect(settled?.['open_contradiction_count']).toBe(3);
      expect(settled).toEqual(await freshDerivation(subject, TENANT_A));
      expect(await requestOf(subject)).toBeNull();
    });

    // ---- 4. merge during recompute -------------------------------------------
    it('4 — a merge into a cluster waits for an in-flight recompute; the next recompute sees the merged evidence', async () => {
      const ty = uuidv7();
      const tx = uuidv7();
      await h.seedEvidence(TENANT_A, ty);
      const evX = await h.seedEvidence(TENANT_A, tx);
      await h.trust.contradictRecord(TENANT_A, evX, 'x has a contradiction');
      const y = await subjectOf(TENANT_A, ty);
      const x = await subjectOf(TENANT_A, tx);
      const g = gate();
      const inflight = pausedRecompute(y, TENANT_A, g);
      await g.reached;
      let merged = false;
      const merge = h.trust.mergeSubjects(y, x, 'merge during recompute', ACTOR).then(() => (merged = true));
      await new Promise((r) => setTimeout(r, 750));
      expect(merged).toBe(false); // the topology write waits for the cluster lock
      g.release();
      await inflight;
      await merge;
      await h.trust.recomputeTrustState(y, TENANT_A);
      expect((await trustRow(y))?.['open_contradiction_count']).toBe(1); // x's contradiction now in y's cluster
      expect(await requestOf(x)).toBeNull();
    });

    // ---- 5. cross-tenant recompute + merge refusal ---------------------------
    it('5 — recompute and merge never cross tenants', async () => {
      const tb = uuidv7();
      await h.seedEvidence(TENANT_B, tb);
      const bSubject = await subjectOf(TENANT_B, tb);
      const bBefore = await trustRow(bSubject);
      await expect(h.trust.recomputeTrustState(bSubject, TENANT_A)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await trustRow(bSubject)).toEqual(bBefore);
      const ta = uuidv7();
      await h.seedEvidence(TENANT_A, ta);
      const aSubject = await subjectOf(TENANT_A, ta);
      const ops = async () =>
        Number((await h.db.query(`SELECT count(*)::int AS n FROM talent_trust."SubjectMergeOperation" WHERE merged_subject_id = $1::uuid OR surviving_subject_id = $1::uuid`, [bSubject])).rows[0].n);
      const opsBefore = await ops();
      await expect(h.trust.mergeSubjects(aSubject, bSubject, 'cross-tenant', ACTOR)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const bRow = (await h.db.query(`SELECT status, merged_into_subject_id FROM talent_trust."ResolutionSubject" WHERE id = $1::uuid`, [bSubject])).rows[0];
      expect(bRow).toEqual({ status: 'ACTIVE', merged_into_subject_id: null });
      expect(await ops()).toBe(opsBefore); // no merge-operation audit row written
    });

    // ---- 6. atomic evidence insertion ----------------------------------------
    it('6 — evidence insert + CREATED event + request are atomic: an event failure leaves no evidence and no request', async () => {
      const talent = uuidv7();
      await h.seedEvidence(TENANT_A, talent);
      const subject = await subjectOf(TENANT_A, talent);
      await h.trust.recomputeTrustState(subject, TENANT_A); // clears the request
      const count = async () =>
        Number((await h.db.query(`SELECT count(*)::int AS n FROM talent_trust."EvidenceRecord" WHERE subject_id = $1::uuid`, [subject])).rows[0].n);
      const before = await count();
      await expect(
        h.trust.recordEvidence({
          subjectRef: h.refFor(TENANT_A, talent),
          dimension: 'CLAIMS',
          assertion_type: 'CERTIFICATION',
          assertion_payload: { name_raw: 'CKS' },
          source_class: 'AUTHORITATIVE_ISSUER',
          method: 'API_REGISTRY',
          source_ref: { talent_evidence_id: uuidv7() },
          portability_class: 'TENANT_ONLY',
          decay_profile: 'MODERATE',
          created_by: 'G1_FAULT',
        }),
      ).rejects.toThrow();
      expect(await count()).toBe(before);
      expect(await requestOf(subject)).toBeNull();
    });

    // ---- 7. failed recompute → repair ----------------------------------------
    it('7 — a failed post-commit recompute leaves a durable request; the repair job heals it', async () => {
      const talent = uuidv7();
      const ev = await h.seedEvidence(TENANT_A, talent);
      const subject = await subjectOf(TENANT_A, talent);
      await failSubject(subject);
      await expect(h.trust.contradictRecord(TENANT_A, ev, 'recompute will fail')).rejects.toThrow();
      expect((await h.snapshot(ev)).current_status).toBe('CONTRADICTED'); // the transition committed
      expect(await requestOf(subject)).not.toBeNull(); // …and the request survived the failure
      expect((await trustRow(subject))?.['open_contradiction_count']).toBe(0); // stale projection
      await healAll();
      const r = await repair.drainBatch({ batchSize: 50, tenantId: TENANT_A });
      expect(r.repaired).toBeGreaterThanOrEqual(1);
      expect((await trustRow(subject))?.['open_contradiction_count']).toBe(1);
      expect(await requestOf(subject)).toBeNull();
    });

    // ---- 8. first recompute failure (no TrustState row) ----------------------
    it('8 — a subject whose FIRST recompute failed (no TrustState row) is repaired', async () => {
      const talent = uuidv7();
      const subjectId = await h.repo.resolveOrCreateSubject(TENANT_A, 'ATS_TALENT_RECORD', talent, 'g1-test');
      await failSubject(subjectId);
      await expect(h.seedEvidence(TENANT_A, talent)).rejects.toThrow();
      expect(await trustRow(subjectId)).toBeUndefined();
      expect(await requestOf(subjectId)).not.toBeNull();
      await healAll();
      await repair.drainBatch({ batchSize: 50, tenantId: TENANT_A });
      expect(await trustRow(subjectId)).toBeDefined();
      expect(await requestOf(subjectId)).toBeNull();
    });

    // ---- 9. DURABLE-only evidence recovery -----------------------------------
    it('9 — a DURABLE-only subject (never selected by the decay sweep) is repaired', async () => {
      const talent = uuidv7();
      const subjectId = await h.repo.resolveOrCreateSubject(TENANT_A, 'ATS_TALENT_RECORD', talent, 'g1-test');
      await failSubject(subjectId);
      await expect(
        h.trust.recordEvidence({
          subjectRef: h.refFor(TENANT_A, talent),
          dimension: 'IDENTITY',
          assertion_type: 'GOVERNMENT_ID',
          assertion_payload: { doc: 'passport' },
          source_class: 'AUTHORITATIVE_ISSUER',
          method: 'DOCUMENT',
          portability_class: 'TENANT_ONLY',
          decay_profile: 'DURABLE',
          created_by: 'g1-durable',
        }),
      ).rejects.toThrow();
      await healAll();
      await repair.drainBatch({ batchSize: 50, tenantId: TENANT_A });
      expect(await trustRow(subjectId)).toBeDefined();
      expect(await requestOf(subjectId)).toBeNull();
    });

    // ---- 10. a newer request arriving during recompute is never cleared ------
    it('10 — a request made while a recompute is in flight survives that recompute', async () => {
      const talent = uuidv7();
      await h.seedEvidence(TENANT_A, talent);
      const ev2 = await h.seedEvidence(TENANT_A, talent);
      const subject = await subjectOf(TENANT_A, talent);
      await h.trust.recomputeTrustState(subject, TENANT_A);
      const g = gate();
      const inflight = pausedRecompute(subject, TENANT_A, g);
      await g.reached;
      // A lifecycle write WITHOUT its own recompute (repository transition only).
      const write = h.repo.applyTenantBoundTransition({
        evidence_id: ev2,
        tenant_id: TENANT_A,
        expected_status: 'VALID',
        next_status: 'STALE',
        event_type: 'MARKED_STALE',
      });
      await new Promise((r) => setTimeout(r, 500));
      g.release();
      await inflight;
      expect(await write).toBe(true);
      expect(await requestOf(subject)).not.toBeNull(); // the newer request was NOT cleared
    });

    // ---- 11. repair idempotency, batching, retries ---------------------------
    it('11 — the repair job batches, backs off failures without clearing them, and is idempotent under overlap', async () => {
      await repair.drainBatch({ batchSize: 500 }); // settle prior tests' requests
      const subjects: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const t = uuidv7();
        await h.seedEvidence(TENANT_A, t);
        const s = await subjectOf(TENANT_A, t);
        await h.db.query(`UPDATE talent_trust."ResolutionSubject" SET trust_recompute_requested_at = now() WHERE id = $1::uuid`, [s]);
        subjects.push(s);
      }
      await failSubject(subjects[0]!);
      const first = await repair.drainBatch({ batchSize: 2, tenantId: TENANT_A });
      expect(first.attempted).toBe(2);
      expect(first.failed).toBe(1); // subjects[0] failed — deferred, not cleared
      expect(await requestOf(subjects[0]!)).not.toBeNull();
      await healAll();
      const [a, b] = await Promise.all([
        repair.drainBatch({ batchSize: 50, tenantId: TENANT_A }),
        repair.drainBatch({ batchSize: 50, tenantId: TENANT_A }),
      ]);
      expect(a.failed + b.failed).toBe(0);
      for (const s of subjects) {
        expect(await requestOf(s)).toBeNull();
        expect(await trustRow(s)).toEqual(await freshDerivation(s, TENANT_A));
      }
      expect((await repair.drainBatch({ batchSize: 50, tenantId: TENANT_A })).attempted).toBe(0);
    });
  },
);
