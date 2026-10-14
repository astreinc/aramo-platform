import { Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ContradictionDetectionService } from '@aramo/talent-reconcile';

import {
  startTrustTenantHarness,
  type EvidenceSnapshot,
  type TrustTenantHarness,
} from './support/trust-tenant-isolation-harness.js';

// Security S1b — internal evidence-id lifecycle hardening (canonical directive
// Aramo-Security-S1-Talent-Trust-Tenant-Isolation-Remediation-Directive-v1_0-
// LOCKED §4; Architect rulings D-S1b-1/2/3, 2026-10-14). markStale / revoke /
// contradictRecord / contradict / supersede (and the continuity retire path) are
// tenant-bound and atomic: another tenant's evidence id ≡ a missing one (404
// NOT_FOUND) and a refusal writes NOTHING (status, event, link, TrustState).

const TENANT_A = '01900000-0000-7000-8000-00000006a001'; // acting tenant
const TENANT_B = '01900000-0000-7000-8000-00000006b002'; // owning tenant

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? `non-aramo:${(e as Error).name}`;
  }
  return 'no-throw';
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Security S1b — tenant-bound internal evidence lifecycle (real Postgres)',
  () => {
    let h: TrustTenantHarness;

    beforeAll(async () => {
      h = await startTrustTenantHarness([TENANT_A, TENANT_B]);
      // Test-only fault injection (disposable DB): an EvidenceEvent insert whose
      // reason is the marker raises — AFTER the status flip and the link insert.
      await h.db.query(`
        CREATE OR REPLACE FUNCTION public.s1b_event_fault() RETURNS trigger AS $$
        BEGIN
          IF NEW.reason = 'S1B_FAULT' THEN RAISE EXCEPTION 's1b injected event fault'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER s1b_event_fault BEFORE INSERT ON talent_trust."EvidenceEvent"
          FOR EACH ROW EXECUTE FUNCTION public.s1b_event_fault();
      `);
    }, 600_000);

    afterAll(async () => {
      await h?.close();
    }, 60_000);

    const seed = async (tenant: string, talent: string = uuidv7()): Promise<string> => h.seedEvidence(tenant, talent);
    const untouched = (before: EvidenceSnapshot, after: EvidenceSnapshot): void => {
      expect(after.current_status).toBe(before.current_status);
      expect(after.events).toBe(before.events);
      expect(after.links).toBe(before.links);
      expect(after.trust_state).toBe(before.trust_state);
    };
    const linkCount = async (from: string, to: string, relation: string): Promise<number> =>
      Number(
        (
          await h.db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM talent_trust."EvidenceLink" WHERE from_evidence_id = $1::uuid AND to_evidence_id = $2::uuid AND relation = $3`,
            [from, to, relation],
          )
        ).rows[0]!.n,
      );

    // ---- B1: single-record ops refuse another tenant's evidence ------------
    it('B1 — markStale / revoke / contradictRecord on another tenant’s evidence: NOT_FOUND, nothing written', async () => {
      const ev = await seed(TENANT_B);
      for (const op of [
        () => h.trust.markStale(TENANT_A, ev),
        () => h.trust.revoke(TENANT_A, ev, 'foreign'),
        () => h.trust.contradictRecord(TENANT_A, ev, 'foreign'),
      ]) {
        const before = await h.snapshot(ev);
        expect(await codeOf(op())).toBe('NOT_FOUND');
        untouched(before, await h.snapshot(ev));
      }
    });

    // ---- B2/B3: relational ops validate BOTH records -----------------------
    it('B2 — contradict: a foreign primary or a foreign counterpart is NOT_FOUND; no cross-tenant link; self-relation refused', async () => {
      const mine = await seed(TENANT_A);
      const foreign = await seed(TENANT_B);
      for (const [primary, by] of [
        [foreign, mine],
        [mine, foreign],
      ] as const) {
        const bp = await h.snapshot(primary);
        const bb = await h.snapshot(by);
        expect(await codeOf(h.trust.contradict(TENANT_A, primary, by, 'x'))).toBe('NOT_FOUND');
        untouched(bp, await h.snapshot(primary));
        untouched(bb, await h.snapshot(by));
        expect(await linkCount(by, primary, 'CONTRADICTS')).toBe(0);
      }
      const before = await h.snapshot(mine);
      expect(await codeOf(h.trust.contradict(TENANT_A, mine, mine, 'self'))).toBe('INVALID_REQUEST');
      untouched(before, await h.snapshot(mine));
    });

    it('B3 — supersede: a foreign old or new record is NOT_FOUND; no cross-tenant link', async () => {
      const mine = await seed(TENANT_A);
      const foreign = await seed(TENANT_B);
      for (const [oldId, newId] of [
        [foreign, mine],
        [mine, foreign],
      ] as const) {
        const bo = await h.snapshot(oldId);
        const bn = await h.snapshot(newId);
        expect(await codeOf(h.trust.supersede(TENANT_A, oldId, newId))).toBe('NOT_FOUND');
        untouched(bo, await h.snapshot(oldId));
        untouched(bn, await h.snapshot(newId));
        expect(await linkCount(newId, oldId, 'SUPERSEDES')).toBe(0);
      }
    });

    // ---- B4: link + status + event are one transaction ---------------------
    it('B4 — an injected failure after the flip and the link leaves no status change, no link, no event', async () => {
      const a = await seed(TENANT_A);
      const b = await seed(TENANT_A);
      const before = await h.snapshot(a);
      await expect(
        h.repo.applyTenantBoundTransition({
          evidence_id: a,
          tenant_id: TENANT_A,
          expected_status: 'VALID',
          next_status: 'CONTRADICTED',
          event_type: 'CONTRADICTED',
          reason: 'S1B_FAULT',
          linked_evidence_id: b,
          link: { from_evidence_id: b, to_evidence_id: a, relation: 'CONTRADICTS' },
        }),
      ).rejects.toThrow();
      untouched(before, await h.snapshot(a));
      expect(await linkCount(b, a, 'CONTRADICTS')).toBe(0);
      // A tenant mismatch at the repository boundary writes nothing either.
      expect(
        await h.repo.applyTenantBoundTransition({
          evidence_id: a,
          tenant_id: TENANT_B,
          expected_status: 'VALID',
          next_status: 'STALE',
          event_type: 'MARKED_STALE',
        }),
      ).toBe(false);
      untouched(before, await h.snapshot(a));
    });

    // ---- B5: idempotency + concurrency of the relational writes ------------
    it('B5 — repeat and concurrent contradict / supersede write exactly one link and one event', async () => {
      const a = await seed(TENANT_A);
      const b = await seed(TENANT_A);
      await Promise.all([1, 2, 3].map(() => h.trust.contradict(TENANT_A, a, b, 'race')));
      await h.trust.contradict(TENANT_A, a, b, 'repeat (no-op)');
      expect(await linkCount(b, a, 'CONTRADICTS')).toBe(1);
      const contradicted = await h.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM talent_trust."EvidenceEvent" WHERE evidence_id = $1::uuid AND event_type = 'CONTRADICTED'`,
        [a],
      );
      expect(Number(contradicted.rows[0]!.n)).toBe(1);

      const o = await seed(TENANT_A);
      const n = await seed(TENANT_A);
      await Promise.all([1, 2, 3].map(() => h.trust.supersede(TENANT_A, o, n)));
      expect(await linkCount(n, o, 'SUPERSEDES')).toBe(1);
      expect((await h.snapshot(o)).current_status).toBe('SUPERSEDED');
    });

    // ---- B6: legitimate same-tenant behaviour is unchanged -----------------
    it('B6 — same-tenant markStale / revoke / contradictRecord / contradict / supersede behave as before, with recompute', async () => {
      const s = await seed(TENANT_A);
      await h.trust.markStale(TENANT_A, s);
      expect((await h.snapshot(s)).current_status).toBe('STALE');
      await h.trust.revoke(TENANT_A, s, 'issuer revoked'); // not status-guarded (any status → REVOKED, as before)
      expect((await h.snapshot(s)).current_status).toBe('REVOKED');

      const c = await seed(TENANT_A);
      await h.trust.contradictRecord(TENANT_A, c, 'impossible range');
      const afterFirst = await h.snapshot(c);
      expect(afterFirst.current_status).toBe('CONTRADICTED');
      await h.trust.contradictRecord(TENANT_A, c, 'repeat');
      expect((await h.snapshot(c)).events).toBe(afterFirst.events); // idempotent no-op

      const talent = uuidv7();
      const x = await seed(TENANT_A, talent);
      const y = await seed(TENANT_A, talent);
      const stateBefore = await h.trust.getTrustState(h.refFor(TENANT_A, talent));
      await h.trust.contradict(TENANT_A, x, y, 'conflict');
      const ev = (
        await h.db.query<{ tenant_id: string; linked_evidence_id: string }>(
          `SELECT tenant_id, linked_evidence_id FROM talent_trust."EvidenceEvent" WHERE evidence_id = $1::uuid AND event_type = 'CONTRADICTED'`,
          [x],
        )
      ).rows[0]!;
      expect(ev).toEqual({ tenant_id: TENANT_A, linked_evidence_id: y });
      const stateAfter = await h.trust.getTrustState(h.refFor(TENANT_A, talent));
      expect(stateAfter?.open_contradiction_count).toBe((stateBefore?.open_contradiction_count ?? 0) + 1);

      const o = await seed(TENANT_A);
      const n = await seed(TENANT_A);
      await h.trust.supersede(TENANT_A, o, n);
      expect((await h.snapshot(o)).current_status).toBe('SUPERSEDED');
      expect(await linkCount(n, o, 'SUPERSEDES')).toBe(1);
    });

    // ---- B7: the cluster rule is advisory (Architect exception D-S1b-1) ----
    it('B7 — a same-tenant pair outside one subject cluster proceeds and is LOGGED (advisory, not refused)', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const a = await seed(TENANT_A, uuidv7()); // subject 1
      const b = await seed(TENANT_A, uuidv7()); // subject 2 (unmerged)
      await h.trust.contradict(TENANT_A, a, b, 'cross-subject');
      expect(await linkCount(b, a, 'CONTRADICTS')).toBe(1);
      expect(
        warn.mock.calls.some(
          ([m]) => typeof m === 'object' && m !== null && (m as { event?: string }).event === 'trust_relationship_cluster_mismatch',
        ),
      ).toBe(true);
      warn.mockRestore();
    });

    // ---- B8: the contradiction detector keeps refused work pending ---------
    it('B8 — contradiction detection with evidence of another tenant: outcome refused, row not resolved, nothing written', async () => {
      const detector = h.module.get(ContradictionDetectionService);
      const incumbent = await seed(TENANT_B);
      const fresh = await seed(TENANT_B);
      const before = await h.snapshot(incumbent);
      const result = await detector.resolvePending({
        id: uuidv7(),
        tenant_id: TENANT_A, // the pending row's tenant ≠ the evidence's tenant
        talent_record_id: uuidv7(),
        field_name: 'email1',
        new_evidence_id: fresh,
        incumbent_evidence_id: incumbent,
      });
      expect(result.outcome).toBe('refused');
      untouched(before, await h.snapshot(incumbent));
      expect(await linkCount(fresh, incumbent, 'CONTRADICTS')).toBe(0);
    });
  },
);
