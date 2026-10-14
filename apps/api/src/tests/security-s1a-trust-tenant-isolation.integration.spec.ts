import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RecomputeSweepService } from '../talent-identity/recompute-sweep.service.js';

import {
  startTrustTenantHarness,
  type EvidenceSnapshot,
  type HttpResult,
  type TrustTenantHarness,
} from './support/trust-tenant-isolation-harness.js';

// Security S1a — the Talent Trust tenant-isolation regression suite (canonical
// directive Aramo-Security-S1-Talent-Trust-Tenant-Isolation-Remediation-Directive-
// v1_0-LOCKED §5, T1–T12). Every foreign-tenant case asserts ALL of: (a) 404 with
// envelope NOT_FOUND; (b) no status disclosed; (c) EvidenceRecord status, (d)
// EvidenceEvent count, (e) EvidenceLink count unchanged; (f) the owning subject's
// TrustState row byte-identical. These assertions FAIL on the pre-fix code (the
// reproduction recorded 200 + mutation for T1/T3/T4).

const TENANT_A = '01900000-0000-7000-8000-00000005a001'; // acting tenant
const TENANT_B = '01900000-0000-7000-8000-00000005b002'; // owning (victim) tenant
const USER_A = '00000000-0000-7000-8000-00000005a0aa';
const USER_B = '00000000-0000-7000-8000-00000005b0bb';
const MULTI = '00000000-0000-7000-8000-00000005ab01'; // a member of BOTH tenants

const RAISE = (id: string): string => `/v1/talent/identity/disputes/${id}/raise`;
const RESOLVE = (id: string): string => `/v1/talent/identity/disputes/${id}/resolve`;
const CONTRA = (id: string): string => `/v1/talent/identity/contradictions/${id}/resolve`;
const STATUS_LITERAL = /current_status|\b(VALID|DISPUTED|CONTRADICTED|REVOKED|SUPERSEDED|STALE)\b/;

const errorOf = (r: HttpResult): Record<string, unknown> => (r.body['error'] ?? {}) as Record<string, unknown>;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Security S1a — Talent Trust lifecycle tenant isolation (real Postgres)',
  () => {
    let h: TrustTenantHarness;
    let jwtA: string; // tenant-A identity:resolve holder
    let jwtB: string; // tenant-B identity:resolve holder (same-tenant control)

    beforeAll(async () => {
      h = await startTrustTenantHarness([TENANT_A, TENANT_B]);
      jwtA = await h.jwtFor(TENANT_A, USER_A, ['identity:resolve']);
      jwtB = await h.jwtFor(TENANT_B, USER_B, ['identity:resolve']);
      // Test-only fault injection (disposable DB): an EvidenceEvent insert whose
      // reason is the marker raises; the REVOKED variant fails only the second
      // event of the upheld pair. A TrustState write for a listed subject raises.
      await h.db.query(`
        CREATE TABLE public.s1a_fail_subject (subject_id uuid PRIMARY KEY);
        CREATE OR REPLACE FUNCTION public.s1a_event_fault() RETURNS trigger AS $$
        BEGIN
          IF NEW.reason = 'S1A_FAULT' OR (NEW.reason = 'S1A_FAULT_REVOKED' AND NEW.event_type = 'REVOKED') THEN
            RAISE EXCEPTION 's1a injected event fault';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER s1a_event_fault BEFORE INSERT ON talent_trust."EvidenceEvent"
          FOR EACH ROW EXECUTE FUNCTION public.s1a_event_fault();
        CREATE OR REPLACE FUNCTION public.s1a_trust_state_fault() RETURNS trigger AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM public.s1a_fail_subject f WHERE f.subject_id = NEW.subject_id) THEN
            RAISE EXCEPTION 's1a injected recompute fault';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER s1a_trust_state_fault BEFORE INSERT OR UPDATE ON talent_trust."TrustState"
          FOR EACH ROW EXECUTE FUNCTION public.s1a_trust_state_fault();
      `);
    }, 600_000);

    afterAll(async () => {
      await h?.close();
    }, 60_000);

    // ---- helpers ------------------------------------------------------------
    const seedB = async (): Promise<{ ev: string; talent: string }> => {
      const talent = uuidv7();
      return { ev: await h.seedEvidence(TENANT_B, talent), talent };
    };
    const disputedB = async (): Promise<string> => {
      const { ev } = await seedB();
      await h.trust.dispute(TENANT_B, ev, USER_B, 'owner-side dispute (setup)');
      return ev;
    };
    const contradictedB = async (): Promise<string> => {
      const { ev } = await seedB();
      await h.trust.contradictRecord(TENANT_B, ev, 'owner-side contradiction (setup)');
      return ev;
    };
    // The universal foreign-tenant predicate (a)–(f).
    const expectConcealedAndUntouched = (r: HttpResult, before: EvidenceSnapshot, after: EvidenceSnapshot): void => {
      expect(r.status).toBe(404); // (a)
      expect(errorOf(r)['code']).toBe('NOT_FOUND'); // (a)
      expect(JSON.stringify(r.body)).not.toMatch(STATUS_LITERAL); // (b)
      expect(after.current_status).toBe(before.current_status); // (c)
      expect(after.events).toBe(before.events); // (d)
      expect(after.links).toBe(before.links); // (e)
      expect(after.trust_state).toBe(before.trust_state); // (f)
    };
    const attackA = async (path: string, ev: string, body: unknown): Promise<void> => {
      const before = await h.snapshot(ev);
      const r = await h.post(path, jwtA, body);
      expectConcealedAndUntouched(r, before, await h.snapshot(ev));
    };

    // ---- T1–T4: the reproduced exploits, inverted --------------------------
    it('T1 — tenant A cannot raise a dispute on tenant B evidence', async () => {
      const { ev } = await seedB();
      await attackA(RAISE(ev), ev, { grounds: 'foreign attempt' });
    });

    it('T2 — tenant A cannot resolve (rejected) a tenant B dispute', async () => {
      const ev = await disputedB();
      await attackA(RESOLVE(ev), ev, { outcome: 'rejected', justification: 'foreign attempt' });
    });

    it('T3 — tenant A cannot resolve (upheld) a tenant B dispute: no DISPUTE_RESOLVED / REVOKED', async () => {
      const ev = await disputedB();
      await attackA(RESOLVE(ev), ev, { outcome: 'upheld', justification: 'foreign attempt' });
      const types = (
        await h.db.query<{ event_type: string }>(
          `SELECT event_type FROM talent_trust."EvidenceEvent" WHERE evidence_id = $1::uuid ORDER BY occurred_at, id`,
          [ev],
        )
      ).rows.map((x) => x.event_type);
      expect(types).toEqual(['CREATED', 'DISPUTED']);
    });

    it('T4 — tenant A cannot resolve a tenant B contradiction', async () => {
      const ev = await contradictedB();
      await attackA(CONTRA(ev), ev, { reason: 'foreign attempt' });
    });

    // ---- T5: foreign id never reaches a 422 (no status leak) ---------------
    it('T5 — a foreign id in every refusal-eligible state is 404, never 422', async () => {
      const valid = (await seedB()).ev;
      await attackA(RESOLVE(valid), valid, { outcome: 'rejected', justification: 'x' });
      await attackA(CONTRA(valid), valid, { reason: 'x' });
      const disputed = await disputedB();
      await attackA(RAISE(disputed), disputed, { grounds: 'x' }); // the repeat-raise echo is not reachable
      await attackA(CONTRA(disputed), disputed, { reason: 'x' });
      const contradicted = await contradictedB();
      await attackA(RAISE(contradicted), contradicted, { grounds: 'x' });
      await attackA(RESOLVE(contradicted), contradicted, { outcome: 'upheld', justification: 'x' });
    });

    // ---- T6: foreign ≡ non-existent ----------------------------------------
    it('T6 — a foreign id and a random non-existent id are indistinguishable on every route', async () => {
      const foreign = (await seedB()).ev;
      const ghost = uuidv7();
      const strip = (r: HttpResult): unknown => {
        const e = { ...errorOf(r) };
        delete e['request_id'];
        return { status: r.status, keys: Object.keys(r.body).sort(), error: e };
      };
      for (const [path, body] of [
        [RAISE, { grounds: 'x' }],
        [RESOLVE, { outcome: 'upheld', justification: 'x' }],
        [CONTRA, { reason: 'x' }],
      ] as const) {
        const f = await h.post(path(foreign), jwtA, body);
        const g = await h.post(path(ghost), jwtA, body);
        expect(strip(f)).toEqual(strip(g));
        expect(f.status).toBe(404);
        expect(errorOf(g)['code']).toBe('NOT_FOUND'); // was INTERNAL_ERROR pre-fix
      }
    });

    // ---- T7: same-tenant behaviour preserved --------------------------------
    it('T7 — same-tenant raise / repeat / rejected / upheld / contradiction and 422 details are unchanged', async () => {
      const { ev } = await seedB();
      const r1 = await h.post(RAISE(ev), jwtB, { grounds: 'owner raise' });
      expect(r1.status).toBe(200);
      expect(r1.body['status']).toBe('DISPUTED');
      const r2 = await h.post(RAISE(ev), jwtB, { grounds: 'repeat' });
      expect(r2.status).toBe(200);
      expect(r2.body['status']).toBe('DISPUTED'); // idempotent echo
      const rej = await h.post(RESOLVE(ev), jwtB, { outcome: 'rejected', justification: 'record stands' });
      expect(rej.body['status']).toBe('VALID');

      const up = await disputedB();
      const u = await h.post(RESOLVE(up), jwtB, { outcome: 'upheld', justification: 'retire' });
      expect(u.status).toBe(200);
      expect(u.body['status']).toBe('REVOKED');
      const types = (
        await h.db.query<{ event_type: string; tenant_id: string; actor: string }>(
          `SELECT event_type, tenant_id, actor FROM talent_trust."EvidenceEvent" WHERE evidence_id = $1::uuid ORDER BY occurred_at, id`,
          [up],
        )
      ).rows;
      expect(types.map((t) => t.event_type)).toEqual(['CREATED', 'DISPUTED', 'DISPUTE_RESOLVED', 'REVOKED']);
      expect(types.slice(2).every((t) => t.tenant_id === TENANT_B && t.actor === USER_B)).toBe(true);

      const c = await contradictedB();
      const cr = await h.post(CONTRA(c), jwtB, { reason: 'reviewed' });
      expect(cr.status).toBe(200);
      expect((await h.snapshot(c)).current_status).toBe('VALID');

      // The owning tenant still sees the domain refusal with current_status.
      const valid = (await seedB()).ev;
      const nd = await h.post(RESOLVE(valid), jwtB, { outcome: 'upheld', justification: 'x' });
      expect(nd.status).toBe(422);
      expect(errorOf(nd)['code']).toBe('EVIDENCE_NOT_DISPUTED');
      expect((errorOf(nd)['details'] as Record<string, unknown>)['current_status']).toBe('VALID');
    });

    // ---- T8: multi-membership cannot borrow authority across tenants -------
    it('T8 — a member of both tenants reads a B id in a B session but cannot act on it with the A grant', async () => {
      const { ev, talent } = await seedB();
      const readB = await h.jwtFor(TENANT_B, MULTI, ['talent:read']); // no identity:resolve in B
      const page = await h.get(`/v1/talent-records/${talent}/dossier/evidence`, readB);
      expect(page.status).toBe(200);
      expect(JSON.stringify(page.body)).toContain(ev); // the id is genuinely obtainable in B
      const resolveA = await h.jwtFor(TENANT_A, MULTI, ['identity:resolve']);
      const denyInB = await h.post(RAISE(ev), readB, { grounds: 'x' });
      expect(denyInB.status).toBe(403); // B role limits hold in B
      for (const [path, body] of [
        [RAISE, { grounds: 'x' }],
        [RESOLVE, { outcome: 'upheld', justification: 'x' }],
        [CONTRA, { reason: 'x' }],
      ] as const) {
        const before = await h.snapshot(ev);
        const r = await h.post(path(ev), resolveA, body);
        expectConcealedAndUntouched(r, before, await h.snapshot(ev));
      }
    });

    // ---- T9: portal-originated paths (C4–C7) --------------------------------
    it('T9 — portal triage, disposition and withdrawal work under their own tenant; a cross-tenant VR is not resolvable', async () => {
      const now = new Date();
      const due = new Date(now.getTime() + 30 * 86_400_000);
      // A tenant-A subject with a CONFIRMED anchor backed by A evidence.
      const seedA = async (): Promise<{ ev: string; subject: string }> => {
        const talent = uuidv7();
        const ev = await h.seedEvidence(TENANT_A, talent);
        const subject = (await h.trust.resolveSubjectRef(h.refFor(TENANT_A, talent)))!.id;
        return { ev, subject };
      };
      const openDispute = async (cluster: string, items: Array<{ tenant: string; subject: string; type: string; ref: string }>) => {
        const d = uuidv7();
        await h.db.query(
          `INSERT INTO talent_trust."PortalDispute" (id, cluster_id, item_type, item_id_digest, triage_due_at, summary_due_at, reinvestigation_due_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $5, $5, now())`,
          [d, cluster, items[0]!.type, `digest-${d}`, due],
        );
        const wis: string[] = [];
        for (const it of items) {
          const wi = uuidv7();
          wis.push(wi);
          await h.db.query(
            `INSERT INTO talent_trust."PortalDisputeWorkItem" (id, dispute_id, tenant_id, subject_id, item_type, underlying_ref_id, updated_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, now())`,
            [wi, d, it.tenant, it.subject, it.type, it.ref],
          );
        }
        return { d, wis };
      };
      const anchorFor = async (tenant: string, subject: string, ev: string, sourceClass: string, value: string): Promise<string> => {
        const id = uuidv7();
        await h.db.query(
          `INSERT INTO talent_trust."SubjectAnchor" (id, subject_id, tenant_id, anchor_kind, normalized_value, source_evidence_id, source_class)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'EMAIL', $4, $5::uuid, $6)`,
          [id, subject, tenant, value, ev, sourceClass],
        );
        return id;
      };
      const wiStatus = async (id: string): Promise<string> =>
        (await h.db.query<{ status: string }>(`SELECT status FROM talent_trust."PortalDisputeWorkItem" WHERE id = $1::uuid`, [id])).rows[0]!.status;

      // C4 + C5 — triage (dispute) then disposition (RESOLVED_UPHELD → rejected → VALID).
      const a1 = await seedA();
      const an1 = await anchorFor(TENANT_A, a1.subject, a1.ev, 'SELF', `a1-${uuidv7()}@x.test`);
      const p1 = await openDispute(uuidv7(), [{ tenant: TENANT_A, subject: a1.subject, type: 'ANCHOR', ref: an1 }]);
      await h.trust.triagePortalDispute({ tenantId: TENANT_A, disputeId: p1.d, actor: USER_A, requestId: 't9' });
      expect((await h.snapshot(a1.ev)).current_status).toBe('DISPUTED');
      expect(await wiStatus(p1.wis[0]!)).toBe('UNDER_REVIEW');
      await h.trust.disposePortalDispute({ tenantId: TENANT_A, disputeId: p1.d, outcome: 'RESOLVED_UPHELD', note: 'stands', actor: USER_A, requestId: 't9' });
      expect((await h.snapshot(a1.ev)).current_status).toBe('VALID');

      // C6 — withdrawal (talent-initiated) restores the triaged item under its own tenant.
      const a2 = await seedA();
      const an2 = await anchorFor(TENANT_A, a2.subject, a2.ev, 'SELF', `a2-${uuidv7()}@x.test`);
      const cluster2 = uuidv7();
      const p2 = await openDispute(cluster2, [{ tenant: TENANT_A, subject: a2.subject, type: 'ANCHOR', ref: an2 }]);
      await h.trust.triagePortalDispute({ tenantId: TENANT_A, disputeId: p2.d, actor: USER_A, requestId: 't9' });
      expect((await h.snapshot(a2.ev)).current_status).toBe('DISPUTED');
      await h.trust.withdrawPortalDispute({ clusterId: cluster2, disputeId: p2.d, actor: 'portal-principal', now: new Date(), requestId: 't9' });
      expect((await h.snapshot(a2.ev)).current_status).toBe('VALID');

      // C7 — a tenant-A VERIFICATION item pointing at a tenant-B VerificationRequest
      // whose B anchor backs B evidence: not resolvable; B evidence untouched.
      const { ev: bEv, talent: bTalent } = await seedB();
      const bSubject = (await h.trust.resolveSubjectRef(h.refFor(TENANT_B, bTalent)))!.id;
      const value = `b-${uuidv7()}@x.test`;
      await anchorFor(TENANT_B, bSubject, bEv, 'PLATFORM_VERIFIED', value);
      const vr = uuidv7();
      await h.db.query(
        `INSERT INTO talent_trust."VerificationRequest" (id, tenant_id, talent_record_id, subject_id, anchor_kind, normalized_value, token_hash, created_by, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'EMAIL', $5, $6, 's1a', $7)`,
        [vr, TENANT_B, bTalent, bSubject, value, `tok-${vr}`, due],
      );
      const a3 = await seedA();
      const p3 = await openDispute(uuidv7(), [{ tenant: TENANT_A, subject: a3.subject, type: 'VERIFICATION', ref: vr }]);
      const before = await h.snapshot(bEv);
      await h.trust.triagePortalDispute({ tenantId: TENANT_A, disputeId: p3.d, actor: USER_A, requestId: 't9' });
      expect(await wiStatus(p3.wis[0]!)).toBe('RESOLVED_NO_TRANSITION');
      const after = await h.snapshot(bEv);
      expect(after).toEqual(before);
    });

    // ---- T11: both transactional paths roll back completely ----------------
    it('T11 — an injected failure after the status flip leaves neither status change nor event (both paths)', async () => {
      // applyTenantBoundTransition: the event insert fails AFTER the update.
      const { ev } = await seedB();
      const before = await h.snapshot(ev);
      await expect(
        h.repo.applyTenantBoundTransition({
          evidence_id: ev,
          tenant_id: TENANT_B,
          expected_status: 'VALID',
          next_status: 'DISPUTED',
          event_type: 'DISPUTED',
          reason: 'S1A_FAULT',
          actor: USER_B,
        }),
      ).rejects.toThrow();
      expect(await h.snapshot(ev)).toEqual(before);

      // appendResolvedThenRevoked: the REVOKED (second) event fails after the flip
      // and the first event — nothing persists.
      const d = await disputedB();
      const beforeD = await h.snapshot(d);
      await expect(
        h.repo.appendResolvedThenRevoked({ evidence_id: d, tenant_id: TENANT_B, actor: USER_B, justification: 'S1A_FAULT_REVOKED' }),
      ).rejects.toThrow();
      expect(await h.snapshot(d)).toEqual(beforeD);

      // A tenant mismatch at the repository boundary writes nothing.
      await expect(
        h.repo.appendResolvedThenRevoked({ evidence_id: d, tenant_id: TENANT_A, actor: USER_A, justification: 'x' }),
      ).rejects.toThrow(/did not match the expected tenant\/status/);
      expect(
        await h.repo.applyTenantBoundTransition({
          evidence_id: d,
          tenant_id: TENANT_A,
          expected_status: 'DISPUTED',
          next_status: 'VALID',
          event_type: 'DISPUTE_RESOLVED',
        }),
      ).toBe(false);
      expect(await h.snapshot(d)).toEqual(beforeD);
    });

    // ---- T12: concurrency cannot duplicate a transition --------------------
    it('T12 — concurrent same-tenant raises / upheld resolves yield exactly one transition', async () => {
      const { ev } = await seedB();
      const raises = await Promise.all([1, 2, 3, 4].map(() => h.post(RAISE(ev), jwtB, { grounds: 'race' })));
      expect(raises.every((r) => r.status === 200 && r.body['status'] === 'DISPUTED')).toBe(true);
      const disputedEvents = await h.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM talent_trust."EvidenceEvent" WHERE evidence_id = $1::uuid AND event_type = 'DISPUTED'`,
        [ev],
      );
      expect(Number(disputedEvents.rows[0]!.n)).toBe(1);

      const ups = await Promise.all([1, 2, 3].map(() => h.post(RESOLVE(ev), jwtB, { outcome: 'upheld', justification: 'race' })));
      expect(ups.filter((r) => r.status === 200 && r.body['status'] === 'REVOKED')).toHaveLength(1);
      expect(ups.filter((r) => r.status === 422 && errorOf(r)['code'] === 'EVIDENCE_NOT_DISPUTED')).toHaveLength(2);
      const tail = await h.db.query<{ event_type: string }>(
        `SELECT event_type FROM talent_trust."EvidenceEvent" WHERE evidence_id = $1::uuid ORDER BY occurred_at, id`,
        [ev],
      );
      expect(tail.rows.map((r) => r.event_type)).toEqual(['CREATED', 'DISPUTED', 'DISPUTE_RESOLVED', 'REVOKED']);
    });

    // ---- F (G1 boundary): post-commit recompute failure + recovery ---------
    it('F — a failed post-commit recompute is reported as a failure, not success; only the time-gated sweep (or a later write) heals it', async () => {
      const { ev, talent } = await seedB();
      const subject = (await h.trust.resolveSubjectRef(h.refFor(TENANT_B, talent)))!.id;
      const stateBefore = await h.trust.getTrustState(h.refFor(TENANT_B, talent));
      expect(stateBefore?.has_open_dispute).toBe(false);
      await h.db.query(`INSERT INTO public.s1a_fail_subject (subject_id) VALUES ($1::uuid)`, [subject]);
      const r = await h.post(RAISE(ev), jwtB, { grounds: 'recompute will fail' });
      // Not represented as completed: the request fails (5xx), never a 200.
      expect(r.status).toBeGreaterThanOrEqual(500);
      // The guarded lifecycle transition itself committed (status + one event)…
      expect((await h.snapshot(ev)).current_status).toBe('DISPUTED');
      // …but the projection is stale until recovered.
      expect((await h.trust.getTrustState(h.refFor(TENANT_B, talent)))?.has_open_dispute).toBe(false);
      await h.db.query(`DELETE FROM public.s1a_fail_subject`);

      // Recovery path 1 — the registered daily sweep (time-gated: subjects whose
      // TrustState is older than RECOMPUTE_STALENESS_DAYS) heals it when due.
      const sweep = h.module.get(RecomputeSweepService);
      const notDue = await sweep.drainBatch({ batchSize: 50, tenantId: TENANT_B });
      expect(notDue.attempted).toBe(0); // not yet due → still stale (recorded G1 finding)
      const due = await sweep.drainBatch({
        batchSize: 50,
        tenantId: TENANT_B,
        now: new Date(Date.now() + 31 * 86_400_000),
      });
      expect(due.recomputed).toBeGreaterThanOrEqual(1);
      expect((await h.trust.getTrustState(h.refFor(TENANT_B, talent)))?.has_open_dispute).toBe(true);

      // Path 2 (recorded, NOT a recovery) — an idempotent retry of the raise returns
      // the echo WITHOUT recomputing (pre-existing behaviour), so it does not heal.
      const { ev: ev2, talent: t2 } = await seedB();
      const s2 = (await h.trust.resolveSubjectRef(h.refFor(TENANT_B, t2)))!.id;
      await h.db.query(`INSERT INTO public.s1a_fail_subject (subject_id) VALUES ($1::uuid)`, [s2]);
      expect((await h.post(RAISE(ev2), jwtB, { grounds: 'fail' })).status).toBeGreaterThanOrEqual(500);
      await h.db.query(`DELETE FROM public.s1a_fail_subject`);
      const retry = await h.post(RAISE(ev2), jwtB, { grounds: 'retry' });
      expect(retry.status).toBe(200);
      expect(retry.body['status']).toBe('DISPUTED');
      // The projection stays stale until the sweep or another write recomputes —
      // recorded under G1 (TrustState recompute ordering/concurrency, OPEN).
      expect((await h.trust.getTrustState(h.refFor(TENANT_B, t2)))?.has_open_dispute).toBe(false);
    });
  },
);
