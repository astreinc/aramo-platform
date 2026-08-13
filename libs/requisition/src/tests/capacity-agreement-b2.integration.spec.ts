import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CapacityProjectionRepository, PrismaService } from '@aramo/placement';

// Track 4 / T4-B2 — THE non-vacuous production-model agreement proof (the anti-
// vacuity guard the ruling requires). It establishes, over an ACTUAL seeded
// population, that the new placement-owned AVAILABLE-OPENINGS projection reproduces
// the legacy stored openings_available projection for every state the legacy model
// can represent:
//
//   legacy stored openings_available  ==  max(capacity_balance, 0)
//
// and, separately, that the SIGNED capacity_balance PRESERVES negative (over-
// capacity) truth rather than truncating it at zero (§5). This is NOT the §6
// production preflight (which found prod EMPTY) and NOT an A2 backfill — it is a
// behavioural proof of the capacity MODEL against controlled seeded data.
//
// Anti-vacuity: the seeded requisition population AND the seeded ContractAssignment
// population are asserted > 0 BEFORE any agreement assertion. 0 == 0 over an empty
// set is explicitly rejected.

// Requisition INIT (creates requisition."Requisition" with openings + the legacy
// stored openings_available) + the full placement chain (ContractAssignment is the
// consumption authority the derived projection counts).
const REQUISITION_INIT = resolve(
  __dirname,
  '../../../requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
);
const PLACEMENT_MIGRATIONS = [
  '20260803180000_init_placement_model',
  '20260805120000_placement_offer_and_outbox',
  '20260806090000_placement_tenant_reset_escape',
  '20260807120000_placement_fallthrough_reason',
  '20260808120000_placement_replacement_link',
  '20260809120000_placement_contract_assignment',
  '20260810100000_placement_assignment_ended_value',
  '20260810110000_placement_assignment_aware_guard',
  '20260810120000_placement_assignment_end_reason',
  '20260813130000_t6_b3_commercial_cancellation',
].map((d) => resolve(__dirname, `../../../placement/prisma/migrations/${d}/migration.sql`));

const ALL_MIGRATIONS = [REQUISITION_INIT, ...PLACEMENT_MIGRATIONS];

// Representative population. `stored` is the legacy openings_available value for the
// state (what the pre-B2 pipeline decrement would have left); `active` real ACTIVE
// assignments drive the derived value; `ended` real ENDED assignments must NOT be
// counted. Chosen to exercise the ruling's cases A–F.
type Case = {
  readonly label: string;
  readonly openings: number;
  readonly active: number;
  readonly ended: number;
  readonly stored: number; // legacy openings_available for this representable state
  readonly expected_balance: number; // signed openings - active
  readonly expected_available: number; // max(balance, 0)
  readonly expected_status: string;
};

const CASES: readonly Case[] = [
  // A — no assignments: openings = N, available = N.
  { label: 'A/no-assignments', openings: 3, active: 0, ended: 0, stored: 3, expected_balance: 3, expected_available: 3, expected_status: 'AVAILABLE' },
  // B — partial consumption: 1..N-1 active.
  { label: 'B/partial', openings: 3, active: 1, ended: 0, stored: 2, expected_balance: 2, expected_available: 2, expected_status: 'AVAILABLE' },
  // C — fully consumed: active == openings, balance 0.
  { label: 'C/fully-consumed', openings: 3, active: 3, ended: 0, stored: 0, expected_balance: 0, expected_available: 0, expected_status: 'FULLY_CONSUMED' },
  // D — over-capacity: active > openings; signed balance < 0; public floors at 0.
  { label: 'D/over-capacity', openings: 2, active: 5, ended: 0, stored: 0, expected_balance: -3, expected_available: 0, expected_status: 'OVER_CAPACITY' },
  // E — ENDED assignment does NOT consume active capacity.
  { label: 'E/ended-not-counted', openings: 3, active: 1, ended: 2, stored: 2, expected_balance: 2, expected_available: 2, expected_status: 'AVAILABLE' },
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T4-B2 non-vacuous capacity-model agreement (legacy stored == max(capacity_balance,0)) [real Postgres 17]',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let capacity: CapacityProjectionRepository;
    const tenant_id = randomUUID();
    const seeded: Array<{ c: Case; requisition_id: string }> = [];

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of ALL_MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setup.$executeRawUnsafe(trimmed);
        }
      }
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      capacity = new CapacityProjectionRepository(prisma);

      // Seed each case with ACTUAL rows on BOTH sides of the agreement.
      for (const c of CASES) {
        const requisition_id = randomUUID();
        // Legacy side: a real requisition row carrying the stored openings_available.
        await prisma.$executeRawUnsafe(
          `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, openings, openings_available)
           VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6)`,
          requisition_id,
          tenant_id,
          `req-${c.label}`,
          randomUUID(),
          c.openings,
          c.stored,
        );
        // New side: real ACTIVE + ENDED ContractAssignment rows (distinct talents /
        // placement processes so the assignment-aware one-live guard is respected).
        for (let i = 0; i < c.active; i++) {
          await prisma.contractAssignment.create({
            data: {
              id: randomUUID(),
              tenant_id,
              placement_process_id: randomUUID(),
              submittal_id: randomUUID(),
              requisition_id,
              talent_record_id: randomUUID(),
              started_at: new Date(),
              provenance: 'FORWARD',
              lifecycle_state: 'ACTIVE',
              company_id: randomUUID(),
            },
          });
        }
        for (let i = 0; i < c.ended; i++) {
          await prisma.contractAssignment.create({
            data: {
              id: randomUUID(),
              tenant_id,
              placement_process_id: randomUUID(),
              submittal_id: randomUUID(),
              requisition_id,
              talent_record_id: randomUUID(),
              started_at: new Date(),
              provenance: 'FORWARD',
              lifecycle_state: 'ENDED',
              end_reason: 'COMPLETED',
              company_id: randomUUID(),
            },
          });
        }
        seeded.push({ c, requisition_id });
      }
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('ANTI-VACUITY: the seeded population is non-empty on BOTH sides before any agreement is asserted', async () => {
      const reqRows = (await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM requisition."Requisition" WHERE tenant_id = $1::uuid`,
        tenant_id,
      )) as Array<{ n: number }>;
      const asgRows = await prisma.contractAssignment.count({ where: { tenant_id } });
      // If EITHER population were zero, the agreement below would be vacuous (0==0
      // over an empty set). Reject that explicitly.
      expect(reqRows[0].n).toBe(CASES.length);
      expect(reqRows[0].n).toBeGreaterThan(0);
      const expectedAssignments = CASES.reduce((s, c) => s + c.active + c.ended, 0);
      expect(asgRows).toBe(expectedAssignments);
      expect(asgRows).toBeGreaterThan(0);
    });

    it('AGREEMENT: legacy stored openings_available == max(capacity_balance,0) for every representable seeded state', async () => {
      let comparisons = 0;
      for (const { c, requisition_id } of seeded) {
        // Legacy projection — read the ACTUAL stored column.
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT openings, openings_available FROM requisition."Requisition" WHERE id = $1::uuid`,
          requisition_id,
        )) as Array<{ openings: number; openings_available: number }>;
        expect(rows).toHaveLength(1);
        const legacyStored = rows[0].openings_available;

        // New projection — derived from the ACTIVE ContractAssignment population.
        const derived = await capacity.projectCapacity(tenant_id, requisition_id, rows[0].openings);

        // THE agreement (public AVAILABLE-OPENINGS value).
        expect({ case: c.label, available: legacyStored }).toEqual({
          case: c.label,
          available: derived.openings_available,
        });
        expect(derived.openings_available).toBe(c.expected_available);
        // The two projections coincide on the public value AND match the case model.
        expect(legacyStored).toBe(c.expected_available);
        comparisons++;
      }
      // Non-vacuity restated at the assertion site: real comparisons happened.
      expect(comparisons).toBe(CASES.length);
      expect(comparisons).toBeGreaterThan(0);
    });

    it('SIGNED OVER-CAPACITY: capacity_balance preserves negative truth (D) rather than truncating at zero', async () => {
      const over = seeded.find((s) => s.c.label === 'D/over-capacity');
      expect(over).toBeDefined();
      const derived = await capacity.projectCapacity(tenant_id, over!.requisition_id, over!.c.openings);
      // The PUBLIC value floors at 0 (agrees with the legacy projection)...
      expect(derived.openings_available).toBe(0);
      // ...but the AUTHORITATIVE signed balance is negative and is NOT truncated.
      expect(derived.capacity_balance).toBe(-3);
      expect(derived.capacity_balance).toBeLessThan(0);
      expect(derived.capacity_status).toBe('OVER_CAPACITY');
    });

    it('RESERVATION INVARIANT: openings_reserved == 0 and FULLY_RESERVED is unreachable across the whole seeded population', async () => {
      const statuses = new Set<string>();
      for (const { requisition_id, c } of seeded) {
        const derived = await capacity.projectCapacity(tenant_id, requisition_id, c.openings);
        expect(derived.openings_reserved).toBe(0);
        statuses.add(derived.capacity_status);
      }
      expect(statuses.has('FULLY_RESERVED')).toBe(false);
    });

    it('EXPECTED STATUS + BALANCE per seeded case (characterises A–E end to end)', async () => {
      for (const { c, requisition_id } of seeded) {
        const derived = await capacity.projectCapacity(tenant_id, requisition_id, c.openings);
        expect({ case: c.label, balance: derived.capacity_balance, status: derived.capacity_status }).toEqual({
          case: c.label,
          balance: c.expected_balance,
          status: c.expected_status,
        });
      }
    });
  },
);

// Comment-aware DDL splitter — skips `;` inside `--` line comments (several
// requisition/placement migrations carry them; a comment-blind splitter would
// mis-split). Also tolerant of `$$` dollar-quoted bodies.
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }
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
