import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementRepository } from '../lib/placement.repository.js';
import { CapacityProjectionRepository } from '../lib/capacity/capacity-projection.repository.js';
import { AssignmentPipelineReadRepository } from '../lib/assignment-pipeline-read.repository.js';
import type { CreatePlacementInput } from '../lib/placement-process.types.js';
import type { PlacementState } from '../lib/lifecycle/placement-lifecycle.js';

import { seedAcceptedOffer } from './support/offer-fixture.js';

// Track 7 / T7-PX — Contract-to-Permanent conversion. Real Postgres 17. The full placement
// chain PLUS the T7-PX additive migration. Proves the directive §19 matrix: atomic source
// END + target PermanentPlacement creation, source/target lineage, T_convert commercial close,
// the SAME-TRANSACTION capacity −1/+1 handoff (never a committed 0/2), the stored guarantee-term
// snapshot, idempotent replay, concurrent conversion + END-vs-CONVERT races, tenant isolation,
// already-ended + missing-terms fail-closed, the T9-B3 exclusion, the outbox event set, and
// commercial-history immutability.

const MIGRATIONS = [
  '20260803180000_init_placement_model',
  '20260805120000_placement_offer_and_outbox',
  '20260807120000_placement_fallthrough_reason',
  '20260808120000_placement_replacement_link',
  '20260809120000_placement_contract_assignment',
  '20260810100000_placement_assignment_ended_value',
  '20260810110000_placement_assignment_aware_guard',
  '20260810120000_placement_assignment_end_reason',
  '20260810130000_t5_assignment_rate_version',
  '20260812140000_t6_b1_effective_window_substrate',
  '20260813130000_t6_b3_commercial_cancellation',
  '20260814120000_t7_permanent_placement',
  '20260815120000_t7_p2_falloff_remedy',
  '20260816120000_t7_p3_guarantee_term_versioning',
  '20260817120000_t7_px_contract_to_permanent_conversion',
  '20260824120000_init_offer_model',
  '20260824130000_placement_offer_id',
].map((d) => resolve(__dirname, `../../prisma/migrations/${d}/migration.sql`));

const T5_TERMS = { pay_rate_amount: '80.00', bill_rate_amount: '120.00', currency: 'USD', rate_period: 'HOURLY' } as const;
// Offer Lifecycle (D6) — born PRE_START (downstream of an ACCEPTED offer).
const PATH_TO_READY: PlacementState[] = ['READY_TO_START'];

function splitDdl(sql: string): string[] {
  const out: string[] = []; let current = ''; let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; current += '$$'; i += 1; continue; }
    if (ch === ';' && !inDollar) { out.push(current); current = ''; } else { current += ch; }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}
function baseInput(o: Partial<CreatePlacementInput> = {}): CreatePlacementInput {
  return { tenant_id: randomUUID(), submittal_id: randomUUID(), requisition_id: randomUUID(), talent_record_id: randomUUID(), ...o };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Contract-to-Permanent conversion — T7-PX (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setupClient: PrismaService;
    let prisma: PrismaService;
    let repo: PlacementRepository;
    let capacity: CapacityProjectionRepository;
    let pipeline: AssignmentPipelineReadRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const t = stmt.trim();
          if (t) await setupClient.$executeRawUnsafe(t);
        }
      }
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new PlacementRepository(prisma);
      capacity = new CapacityProjectionRepository(prisma);
      pipeline = new AssignmentPipelineReadRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    // Offer Lifecycle (D6) — create from an ACCEPTED offer (born PRE_START).
    async function createValid(input: CreatePlacementInput, requestId: string) {
      const offer_id = input.offer_id ?? (await seedAcceptedOffer(prisma, { tenant_id: input.tenant_id }));
      return repo.createPlacement({ ...input, offer_id }, requestId);
    }

    // Offer Lifecycle (D6) — create from an ACCEPTED offer (born PRE_START).
    async function createValid(input: CreatePlacementInput, requestId: string) {
      const offer_id = input.offer_id ?? (await seedAcceptedOffer(prisma, { tenant_id: input.tenant_id }));
      return repo.createPlacement({ ...input, offer_id }, requestId);
    }

    async function driveToReady(input: CreatePlacementInput): Promise<string> {
      const c = await createValid(input, 'd'); let id = c.id;
      for (const to of PATH_TO_READY) id = (await repo.transition({ tenant_id: input.tenant_id, placement_process_id: id, to }, 'd')).id;
      return id;
    }
    // Start a CONTRACT placement in STARTED with an ACTIVE ContractAssignment + initial ARV.
    async function startContract(input: CreatePlacementInput): Promise<string> {
      const id = await driveToReady(input);
      await repo.transition(
        { tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', commercial_terms: T5_TERMS, assignment_context: { company_id: randomUUID() }, recorded_by: randomUUID() },
        's',
      );
      return id;
    }
    // Seed a governed guarantee-term version effective from the past (so it is effective at the
    // conversion date = today). Raw insert — deterministic, no revision machinery needed.
    async function seedTerms(tenant_id: string, requisition_id: string, over: { duration?: number; policy?: string; exposure?: string; currency?: string } = {}): Promise<string> {
      const id = randomUUID();
      await setupClient.$executeRawUnsafe(
        `INSERT INTO placement."PermanentPlacementGuaranteeTermVersion"
           (id, tenant_id, requisition_id, effective_from, effective_to, guarantee_duration_days,
            remedy_policy, guarantee_exposure_amount, currency, source_type, source_reference, source_version,
            recorded_by, recorded_at, supersedes_version_id, correlation_id)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'2026-01-01'::date,NULL,$4,
                 $5::placement."RemedyPolicy",$6,$7,'MANUAL',NULL,NULL,
                 $8::uuid,'2026-01-01T00:00:00Z'::timestamptz,NULL,NULL)`,
        id, tenant_id, requisition_id, over.duration ?? 365, over.policy ?? 'REFUND', over.exposure ?? '50000.00', over.currency ?? 'USD', randomUUID(),
      );
      return id;
    }
    async function assignmentRow(tenant_id: string, placement_process_id: string): Promise<{ lifecycle_state: string; end_reason: string | null } | null> {
      const rows = await prisma.$queryRawUnsafe<Array<{ lifecycle_state: string; end_reason: string | null }>>(
        `SELECT lifecycle_state::text AS lifecycle_state, end_reason::text AS end_reason FROM placement."ContractAssignment" WHERE tenant_id = $1::uuid AND placement_process_id = $2::uuid`,
        tenant_id, placement_process_id,
      );
      return rows[0] ?? null;
    }
    async function permanentByPlacement(tenant_id: string, placement_process_id: string): Promise<{ lifecycle_state: string; guarantee_duration_days: number; guarantee_exposure_amount: string; guarantee_exposure_currency: string; remedy_policy: string; guarantee_start_date: string } | null> {
      const rows = await prisma.$queryRawUnsafe<Array<{ lifecycle_state: string; guarantee_duration_days: number; guarantee_exposure_amount: string; guarantee_exposure_currency: string; remedy_policy: string; guarantee_start_date: Date }>>(
        `SELECT lifecycle_state::text AS lifecycle_state, guarantee_duration_days, guarantee_exposure_amount::text AS guarantee_exposure_amount, guarantee_exposure_currency, remedy_policy::text AS remedy_policy, guarantee_start_date FROM placement."PermanentPlacement" WHERE tenant_id = $1::uuid AND placement_process_id = $2::uuid`,
        tenant_id, placement_process_id,
      );
      const r = rows[0];
      return r === undefined ? null : { ...r, guarantee_start_date: r.guarantee_start_date.toISOString().slice(0, 10) };
    }
    async function outboxTypes(tenant_id: string): Promise<string[]> {
      const rows = await prisma.$queryRawUnsafe<Array<{ event_type: string }>>(
        `SELECT event_type FROM placement."OutboxEvent" WHERE tenant_id = $1::uuid`, tenant_id,
      );
      return rows.map((r) => r.event_type);
    }

    // ---- 1/2/3/16 — atomic END + target creation + lineage + event set ----
    it('atomically ends the source assignment (CONVERTED_TO_PERMANENT) and creates the target permanent placement + lineage + events', async () => {
      const input = baseInput();
      const sourceId = await startContract(input);
      await seedTerms(input.tenant_id, input.requisition_id, { duration: 365, policy: 'REFUND', exposure: '50000.00' });

      const result = await repo.convertToPermanent({ tenant_id: input.tenant_id, placement_process_id: sourceId, converted_by: randomUUID() }, 'c');

      expect(result.replayed).toBe(false);
      expect(result.source_placement_process_id).toBe(sourceId);
      expect(result.target_placement_process_id).not.toBe(sourceId);

      // Source assignment ENDED with the genuine domain reason.
      expect(await assignmentRow(input.tenant_id, sourceId)).toEqual({ lifecycle_state: 'ENDED', end_reason: 'CONVERTED_TO_PERMANENT' });
      // Source placement stays frozen at STARTED (historical anchor).
      const srcState = await prisma.$queryRawUnsafe<Array<{ state: string }>>(`SELECT state::text AS state FROM placement."PlacementProcess" WHERE id = $1::uuid`, sourceId);
      expect(srcState[0]?.state).toBe('STARTED');

      // Target permanent placement in GUARANTEE_ACTIVE on a NEW placement process.
      const perm = await permanentByPlacement(input.tenant_id, result.target_placement_process_id);
      expect(perm?.lifecycle_state).toBe('GUARANTEE_ACTIVE');

      // Immutable lineage links source -> target.
      const lineage = await prisma.$queryRawUnsafe<Array<{ source_placement_process_id: string; source_contract_assignment_id: string; target_placement_process_id: string; target_permanent_placement_id: string; converted_by: string }>>(
        `SELECT source_placement_process_id, source_contract_assignment_id, target_placement_process_id, target_permanent_placement_id, converted_by FROM placement."PermanentPlacementConversionLineage" WHERE tenant_id = $1::uuid AND source_placement_process_id = $2::uuid`,
        input.tenant_id, sourceId,
      );
      expect(lineage).toHaveLength(1);
      expect(lineage[0]!.target_placement_process_id).toBe(result.target_placement_process_id);
      expect(lineage[0]!.target_permanent_placement_id).toBe(result.target_permanent_placement_id);

      // §12 event set present (identity/lineage only).
      const types = await outboxTypes(input.tenant_id);
      expect(types).toContain('placement.assignment.ended');
      expect(types).toContain('permanent_placement.created');
      expect(types).toContain('permanent_placement.guarantee_active');
      expect(types).toContain('placement.assignment.converted_to_permanent');
    });

    // ---- 5 — the target snapshot copies the governed stored term version ----
    it('copies the governed stored guarantee-term snapshot (never a caller value) into the target', async () => {
      const input = baseInput();
      const sourceId = await startContract(input);
      await seedTerms(input.tenant_id, input.requisition_id, { duration: 180, policy: 'PRORATED_CREDIT', exposure: '33000.00', currency: 'USD' });
      const result = await repo.convertToPermanent({ tenant_id: input.tenant_id, placement_process_id: sourceId, converted_by: randomUUID() }, 'c');
      const perm = await permanentByPlacement(input.tenant_id, result.target_placement_process_id);
      expect(perm?.guarantee_duration_days).toBe(180);
      expect(perm?.remedy_policy).toBe('PRORATED_CREDIT');
      expect(perm?.guarantee_exposure_amount).toBe('33000.00');
      expect(perm?.guarantee_exposure_currency).toBe('USD');
      // guarantee_start_date derived as the UTC calendar date of the conversion instant (today).
      expect(perm?.guarantee_start_date).toBe(new Date().toISOString().slice(0, 10));
    });

    // ---- 4 — the SAME-TRANSACTION capacity −1/+1 handoff (exactly 1, never 0 or 2) ----
    it('preserves derived capacity at exactly 1 across the conversion (−1 contract, +1 permanent, same tx)', async () => {
      const input = baseInput();
      const sourceId = await startContract(input);
      await seedTerms(input.tenant_id, input.requisition_id);
      expect(await capacity.countActiveByRequisition(input.tenant_id, input.requisition_id)).toBe(1); // ACTIVE contract
      await repo.convertToPermanent({ tenant_id: input.tenant_id, placement_process_id: sourceId, converted_by: randomUUID() }, 'c');
      // After commit: the contract dropped out, the permanent entered — still exactly one consumer.
      expect(await capacity.countActiveByRequisition(input.tenant_id, input.requisition_id)).toBe(1);
    });

    // ---- 6 — idempotent replay (deterministic already-converted) ----
    it('replays the same target on a duplicate conversion of an already-converted source (no second permanent placement)', async () => {
      const input = baseInput();
      const sourceId = await startContract(input);
      await seedTerms(input.tenant_id, input.requisition_id);
      const first = await repo.convertToPermanent({ tenant_id: input.tenant_id, placement_process_id: sourceId, converted_by: randomUUID() }, 'c');
      const second = await repo.convertToPermanent({ tenant_id: input.tenant_id, placement_process_id: sourceId, converted_by: randomUUID() }, 'c');
      expect(second.replayed).toBe(true);
      expect(second.target_placement_process_id).toBe(first.target_placement_process_id);
      expect(second.target_permanent_placement_id).toBe(first.target_permanent_placement_id);
      const count = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM placement."PermanentPlacement" WHERE tenant_id = $1::uuid AND requisition_id = $2::uuid`, input.tenant_id, input.requisition_id);
      expect(Number(count[0]!.n)).toBe(1);
    });

    // ---- 7 — concurrent duplicate conversions cannot create two permanent placements ----
    it('serialises concurrent conversions of the same source to exactly one permanent placement', async () => {
      const input = baseInput();
      const sourceId = await startContract(input);
      await seedTerms(input.tenant_id, input.requisition_id);
      const [a, b] = await Promise.all([
        repo.convertToPermanent({ tenant_id: input.tenant_id, placement_process_id: sourceId, converted_by: randomUUID() }, 'c'),
        repo.convertToPermanent({ tenant_id: input.tenant_id, placement_process_id: sourceId, converted_by: randomUUID() }, 'c'),
      ]);
      expect(a.target_placement_process_id).toBe(b.target_placement_process_id);
      expect(a.replayed !== b.replayed).toBe(true); // exactly one did the work, one replayed
      const count = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM placement."PermanentPlacement" WHERE tenant_id = $1::uuid AND requisition_id = $2::uuid`, input.tenant_id, input.requisition_id);
      expect(Number(count[0]!.n)).toBe(1);
    });

    // ---- 8 — concurrent END vs CONVERT serialises on the assignment lock; exactly one wins ----
    it('serialises a concurrent END and CONVERT on the assignment lock (exactly one succeeds)', async () => {
      const input = baseInput();
      const sourceId = await startContract(input);
      await seedTerms(input.tenant_id, input.requisition_id);
      const settled = await Promise.allSettled([
        repo.convertToPermanent({ tenant_id: input.tenant_id, placement_process_id: sourceId, converted_by: randomUUID() }, 'c'),
        repo.endAssignment({ tenant_id: input.tenant_id, placement_process_id: sourceId, end_reason: 'COMPLETED', ended_by: randomUUID() }, 'e'),
      ]);
      const fulfilled = settled.filter((s) => s.status === 'fulfilled').length;
      const rejected = settled.filter((s) => s.status === 'rejected').length;
      expect(fulfilled).toBe(1);
      expect(rejected).toBe(1);
      // The assignment is ENDED exactly once (by whichever won).
      const row = await assignmentRow(input.tenant_id, sourceId);
      expect(row?.lifecycle_state).toBe('ENDED');
    });

    // ---- 9 — tenant isolation (terms are tenant-scoped) ----
    it('does not resolve another tenant\'s guarantee terms (fails closed cross-tenant)', async () => {
      const reqId = randomUUID();
      const tenantA = randomUUID();
      const inputB = baseInput({ requisition_id: reqId }); // tenant B, SAME requisition id
      const sourceB = await startContract(inputB);
      await seedTerms(tenantA, reqId); // terms exist ONLY under tenant A
      await expect(
        repo.convertToPermanent({ tenant_id: inputB.tenant_id, placement_process_id: sourceB, converted_by: randomUUID() }, 'c'),
      ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_TERMS_NOT_FOUND' });
    });

    // ---- 10 — already-ended source is rejected (not a silent replay) ----
    it('rejects conversion of an already-ended (non-converted) assignment with NOT_FOUND', async () => {
      const input = baseInput();
      const sourceId = await startContract(input);
      await seedTerms(input.tenant_id, input.requisition_id);
      await repo.endAssignment({ tenant_id: input.tenant_id, placement_process_id: sourceId, end_reason: 'COMPLETED', ended_by: randomUUID() }, 'e');
      await expect(
        repo.convertToPermanent({ tenant_id: input.tenant_id, placement_process_id: sourceId, converted_by: randomUUID() }, 'c'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    // ---- 11 — missing governed terms fail closed ----
    it('fails closed when no governed guarantee terms are effective for the requisition', async () => {
      const input = baseInput();
      const sourceId = await startContract(input); // no seedTerms
      await expect(
        repo.convertToPermanent({ tenant_id: input.tenant_id, placement_process_id: sourceId, converted_by: randomUUID() }, 'c'),
      ).rejects.toMatchObject({ code: 'PERMANENT_PLACEMENT_TERMS_NOT_FOUND' });
    });

    // ---- non-STARTED source rejection ----
    it('rejects conversion of a non-STARTED placement (PLACEMENT_STATE_INVALID)', async () => {
      const input = baseInput();
      const id = await driveToReady(input); // READY_TO_START, never started -> no assignment
      await seedTerms(input.tenant_id, input.requisition_id);
      await expect(
        repo.convertToPermanent({ tenant_id: input.tenant_id, placement_process_id: id, converted_by: randomUUID() }, 'c'),
      ).rejects.toMatchObject({ code: 'PLACEMENT_STATE_INVALID' });
    });

    // ---- 12 — T9-B3: converted assignment excluded from attrition; no duplicate pipeline count ----
    it('excludes a converted assignment from T9-B3 attrition and does not double-count the target in by_state', async () => {
      const input = baseInput();
      const sourceId = await startContract(input);
      await seedTerms(input.tenant_id, input.requisition_id);
      await repo.convertToPermanent({ tenant_id: input.tenant_id, placement_process_id: sourceId, converted_by: randomUUID() }, 'c');

      const snap = await pipeline.readAssignmentPipelineSnapshot({ tenant_id: input.tenant_id, requisition_ids: [input.requisition_id], now: new Date() });
      // The converted assignment is neither ACTIVE nor ordinary-ENDED (excluded).
      const ca = snap.contract_assignments as Record<string, number>;
      expect(ca['ended'] ?? 0).toBe(0);
      expect(ca['active'] ?? 0).toBe(0);
      // by_state STARTED counts the frozen SOURCE placement once — NOT the permanent target too.
      const started = snap.by_state.find((r) => r.state === 'STARTED');
      expect(started?.count ?? 0).toBe(1);
    });

    // ---- 17 — commercial history is preserved (closed, never deleted) ----
    it('preserves the source commercial history (the initial rate version is closed at T_convert, not deleted)', async () => {
      const input = baseInput();
      const sourceId = await startContract(input);
      await seedTerms(input.tenant_id, input.requisition_id);
      const before = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM placement."AssignmentRateVersion" arv JOIN placement."ContractAssignment" ca ON ca.id = arv.contract_assignment_id WHERE ca.tenant_id = $1::uuid AND ca.placement_process_id = $2::uuid`, input.tenant_id, sourceId);
      await repo.convertToPermanent({ tenant_id: input.tenant_id, placement_process_id: sourceId, converted_by: randomUUID() }, 'c');
      const after = await prisma.$queryRawUnsafe<Array<{ n: bigint; open: bigint }>>(`SELECT count(*)::bigint AS n, count(*) FILTER (WHERE arv.effective_to IS NULL AND arv.cancelled_at IS NULL)::bigint AS open FROM placement."AssignmentRateVersion" arv JOIN placement."ContractAssignment" ca ON ca.id = arv.contract_assignment_id WHERE ca.tenant_id = $1::uuid AND ca.placement_process_id = $2::uuid`, input.tenant_id, sourceId);
      expect(Number(after[0]!.n)).toBe(Number(before[0]!.n)); // preserved, not deleted
      expect(Number(after[0]!.open)).toBe(0); // the current version is CLOSED at T_convert
    });
  },
);
