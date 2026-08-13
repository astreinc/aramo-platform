import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementRepository } from '../lib/placement.repository.js';
import type { CreatePlacementInput, PlacementState } from '../lib/placement-process.types.js';

// Track 5 / T5-P1 — D-1 proofs for the INITIAL Assignment Rate Version created
// atomically with the FORWARD STARTED ContractAssignment (Amendment A1 + A2).
// Non-vacuous: each proof asserts the exact BEFORE (0 rows) and the EXACT AFTER
// (values / atomic refusal). Real Postgres 17 (the append-only trigger and the
// Decimal(12,2) storage are exercised end-to-end).

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
].map((d) => resolve(__dirname, `../../prisma/migrations/${d}/migration.sql`));

// Dollar-quote-aware, line-comment-blind statement splitter (the migrations keep
// every line comment free of the terminator, so blindness is safe here).
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; cur += '$$'; i += 1; continue; }
    if (sql[i] === ';' && !inDollar) { out.push(cur); cur = ''; } else cur += sql[i];
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const PATH_TO_READY: PlacementState[] = ['OFFER_ACCEPTED', 'PRE_START', 'READY_TO_START'];
const VALID_TERMS = { pay_rate_amount: '80.00', bill_rate_amount: '120.50', currency: 'USD', rate_period: 'HOURLY' } as const;

function baseInput(overrides: Partial<CreatePlacementInput> = {}): CreatePlacementInput {
  return {
    tenant_id: randomUUID(),
    submittal_id: randomUUID(),
    requisition_id: randomUUID(),
    talent_record_id: randomUUID(),
    ...overrides,
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T5-P1 AssignmentRateVersion — initial commercial terms (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setupClient: PrismaService;
    let prisma: PrismaService;
    let repo: PlacementRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const t = stmt.trim();
          if (t.length > 0) await setupClient.$executeRawUnsafe(t);
        }
      }
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new PlacementRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function driveToReady(input: CreatePlacementInput): Promise<string> {
      const created = await repo.createPlacement(input, 'drive');
      let id = created.id;
      for (const to of PATH_TO_READY) {
        const v = await repo.transition({ tenant_id: input.tenant_id, placement_process_id: id, to }, 'drive');
        id = v.id;
      }
      return id;
    }

    const started = (
      input: CreatePlacementInput,
      id: string,
      extra: Record<string, unknown> = {},
    ) =>
      repo.transition(
        {
          tenant_id: input.tenant_id,
          placement_process_id: id,
          to: 'STARTED',
          assignment_context: { company_id: randomUUID() },
          commercial_terms: VALID_TERMS,
          recorded_by: randomUUID(),
          ...extra,
        },
        'x',
      );

    // Proof B (+H, +outbox) — STARTED with valid terms: exactly one rate version
    // after (none before), EXACT values, effective_from == the assignment start,
    // and one identity-only outbox event.
    it('B/H — creates exactly one initial rate version with exact values, sharing the assignment start instant', async () => {
      const input = baseInput();
      const id = await driveToReady(input);
      expect(await prisma.assignmentRateVersion.count({ where: { tenant_id: input.tenant_id } })).toBe(0);

      const recorder = randomUUID();
      await started(input, id, { recorded_by: recorder });

      const rows = await prisma.assignmentRateVersion.findMany({ where: { tenant_id: input.tenant_id } });
      expect(rows).toHaveLength(1);
      const rv = rows[0];
      expect(rv.pay_rate_amount.toString()).toBe('80');
      expect(rv.bill_rate_amount.toString()).toBe('120.5');
      expect(rv.currency).toBe('USD');
      expect(rv.rate_period).toBe('HOURLY');
      expect(rv.recorded_by).toBe(recorder);
      expect(rv.effective_to).toBeNull();

      const ca = await prisma.contractAssignment.findFirst({ where: { tenant_id: input.tenant_id } });
      expect(ca).not.toBeNull();
      expect(rv.contract_assignment_id).toBe(ca!.id);
      // H — one shared effective instant (no per-layer wall-clock drift).
      expect(rv.effective_from.toISOString()).toBe(ca!.started_at.toISOString());

      // Outbox — identity/provenance ONLY, NO commercial values (Amendment A2 §8).
      const ev = await prisma.outboxEvent.findFirst({
        where: { tenant_id: input.tenant_id, event_type: 'placement.assignment.rate_version.created' },
      });
      expect(ev).not.toBeNull();
      const payload = ev!.event_payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual([
        'assignment_rate_version_id',
        'contract_assignment_id',
        'effective_from',
        'requisition_id',
        'talent_record_id',
        'tenant_id',
      ]);
      for (const banned of ['pay_rate_amount', 'bill_rate_amount', 'currency', 'rate_period', 'spread', 'margin', 'markup']) {
        expect(payload).not.toHaveProperty(banned);
      }
    });

    // Proof A/E/F — STARTED WITHOUT commercial terms is refused atomically even
    // though an org snapshot (company_id) is present: Company defaults and
    // requisition targets are NEVER promoted to actuals. ZERO rows written.
    it('A/E/F — STARTED without commercial_terms is refused; no assignment and no rate version are created', async () => {
      const input = baseInput();
      const id = await driveToReady(input);
      await expect(
        repo.transition(
          { tenant_id: input.tenant_id, placement_process_id: id, to: 'STARTED', assignment_context: { company_id: randomUUID() } },
          'x',
        ),
      ).rejects.toMatchObject({ code: 'PLACEMENT_START_COMMERCIAL_TERMS_REQUIRED', statusCode: 422 });
      expect(await prisma.assignmentRateVersion.count({ where: { tenant_id: input.tenant_id } })).toBe(0);
      expect(await prisma.contractAssignment.count({ where: { tenant_id: input.tenant_id } })).toBe(0);
      // The placement did NOT advance to STARTED (atomic refusal before the tx).
      const pp = await prisma.placementProcess.findFirst({ where: { id } });
      expect(pp!.state).toBe('READY_TO_START');
    });

    // Proof G — invalid currency / rate period / malformed money are each refused
    // atomically (no rows). One assertion per malformed field.
    it('G — invalid currency is refused atomically', async () => {
      const input = baseInput();
      const id = await driveToReady(input);
      await expect(started(input, id, { commercial_terms: { ...VALID_TERMS, currency: 'usd' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await prisma.assignmentRateVersion.count({ where: { tenant_id: input.tenant_id } })).toBe(0);
    });
    it('G — invalid rate_period is refused atomically', async () => {
      const input = baseInput();
      const id = await driveToReady(input);
      await expect(started(input, id, { commercial_terms: { ...VALID_TERMS, rate_period: 'FORTNIGHTLY' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await prisma.assignmentRateVersion.count({ where: { tenant_id: input.tenant_id } })).toBe(0);
    });
    it('G — malformed money amount is refused atomically', async () => {
      const input = baseInput();
      const id = await driveToReady(input);
      await expect(started(input, id, { commercial_terms: { ...VALID_TERMS, pay_rate_amount: '80.999' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await prisma.assignmentRateVersion.count({ where: { tenant_id: input.tenant_id } })).toBe(0);
    });

    // Commercial terms may ONLY be supplied at the assignment-start seam — never
    // silently discarded on another edge (Amendment A2 §2).
    it('commercial_terms on a non-STARTED transition is rejected', async () => {
      const input = baseInput();
      const created = await repo.createPlacement(input, 'drive');
      await expect(
        repo.transition(
          { tenant_id: input.tenant_id, placement_process_id: created.id, to: 'OFFER_ACCEPTED', commercial_terms: VALID_TERMS, recorded_by: randomUUID() },
          'x',
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    // Append-only — an existing rate version is absolutely immutable to an ordinary
    // UPDATE (the DB trigger rejects it; the core T5 invariant).
    it('append-only — an ordinary UPDATE of a rate version is rejected by the trigger', async () => {
      const input = baseInput();
      const id = await driveToReady(input);
      await started(input, id);
      const rv = await prisma.assignmentRateVersion.findFirstOrThrow({ where: { tenant_id: input.tenant_id } });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE placement."AssignmentRateVersion" SET pay_rate_amount = 999.99 WHERE id = '${rv.id}'`,
        ),
      ).rejects.toThrow();
      const after = await prisma.assignmentRateVersion.findFirstOrThrow({ where: { id: rv.id } });
      expect(after.pay_rate_amount.toString()).toBe('80');
    });
  },
);
