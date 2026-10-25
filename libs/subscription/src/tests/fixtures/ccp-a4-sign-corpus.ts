import type { Client } from 'pg';

// CCP-A4 (PBD §5.1 A4 row; MP-A2 N-8, N-13) — a deterministic Sign corpus seeded on the
// PRE-A4 schema (no product_key column yet). It covers every N-13 semantic: monthly period
// anchored on the subscription (day clamp), no rollover, reserve/consume/release
// idempotency, voided/declined/expired sends still counted (CONSUMED rows), RELEASED rows
// not counted, stale reservations, 80% / 100% thresholds, hard refusal at exhaustion,
// explicit unlimited with metering, the Free Personal day window, PAST_DUE grace,
// INCOMPLETE, ended-only, no subscription, a plan without the allowance, and storage
// capacity. Every value is fixed, so the observation is byte-stable.

export const AT = new Date('2026-10-18T12:00:00.000Z');
export const KEY = 'sign.envelopes';
export const STORAGE = 'sign.storage_bytes';
export const EVENT = 'sign.envelope.sent';

const PLAN = {
  included: '019a0000-5150-7000-8000-000000000001',
  free: '019a0000-5150-7000-8000-000000000010',
  business: '019a0000-5150-7000-8000-000000000011',
  professional: '019a0000-5150-7000-8000-000000000012',
  enterprise: '019a0000-5150-7000-8000-000000000013',
} as const;

export const T = (n: number): string => `0190a4a4-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SUB = (n: number): string => `0190a4a5-0000-7000-8000-${String(n).padStart(12, '0')}`;

interface Sub {
  n: number;
  plan: keyof typeof PLAN;
  anchor: string;
  source: 'MANUAL' | 'DEVELOPMENT' | 'SELF_SERVICE' | 'FREE';
  status?: string;
  ended_at?: string;
  grace_until?: string;
  activated_by?: string;
  billing?: boolean;
  commitment?: boolean;
  eligibility_state?: string;
  cancel_at_period_end?: boolean;
}

// One subscription per corpus tenant (T(11) has none).
export const SUBS: readonly Sub[] = [
  { n: 1, plan: 'included', anchor: '2026-10-01T00:00:00Z', source: 'DEVELOPMENT' },
  { n: 2, plan: 'included', anchor: '2026-09-15T00:00:00Z', source: 'MANUAL' },
  { n: 3, plan: 'included', anchor: '2026-10-01T00:00:00Z', source: 'MANUAL' },
  { n: 4, plan: 'included', anchor: '2026-10-01T00:00:00Z', source: 'MANUAL' },
  { n: 5, plan: 'included', anchor: '2026-10-01T00:00:00Z', source: 'MANUAL' },
  { n: 6, plan: 'business', anchor: '2026-10-05T00:00:00Z', source: 'SELF_SERVICE', activated_by: 'owner-06', billing: true },
  { n: 7, plan: 'business', anchor: '2026-10-05T00:00:00Z', source: 'SELF_SERVICE', status: 'PAST_DUE', grace_until: '2026-10-20T12:00:00Z', activated_by: 'owner-07', billing: true },
  { n: 8, plan: 'business', anchor: '2026-10-05T00:00:00Z', source: 'SELF_SERVICE', status: 'PAST_DUE', grace_until: '2026-10-17T12:00:00Z', activated_by: 'owner-08', billing: true },
  { n: 9, plan: 'business', anchor: '2026-10-05T00:00:00Z', source: 'SELF_SERVICE', status: 'INCOMPLETE', activated_by: 'owner-09', billing: true },
  { n: 10, plan: 'included', anchor: '2026-09-01T00:00:00Z', source: 'MANUAL', status: 'CANCELED', ended_at: '2026-10-10T00:00:00Z' },
  { n: 12, plan: 'free', anchor: '2026-10-01T00:00:00Z', source: 'FREE' },
  { n: 13, plan: 'professional', anchor: '2026-10-02T00:00:00Z', source: 'SELF_SERVICE', activated_by: 'owner-13', billing: true, commitment: true, eligibility_state: 'OK', cancel_at_period_end: true },
  { n: 14, plan: 'included', anchor: '2026-01-31T00:00:00Z', source: 'MANUAL' },
  { n: 15, plan: 'enterprise', anchor: '2026-10-01T00:00:00Z', source: 'MANUAL' },
];

/** Every corpus tenant id, including T(11) (no subscription). */
export const TENANTS: readonly string[] = [...SUBS.map((s) => T(s.n)), T(11)].sort();

async function usage(pg: Client, tenant: string, prefix: string, n: number, state: string, period_start: string, reserved_at: string, reserved_until = reserved_at): Promise<void> {
  if (n === 0) return;
  await pg.query(
    `INSERT INTO subscription."AllowanceUsage" (id, tenant_id, allowance_key, send_key, period_start, state, origin, reserved_at, reserved_until, finalized_at)
     SELECT gen_random_uuid(), $1::uuid, $2, $3 || ':' || g, $4::timestamptz, $5, 'SEND', $6::timestamptz, $7::timestamptz,
            CASE WHEN $5 = 'RESERVED' THEN NULL ELSE $6::timestamptz END
       FROM generate_series(1, $8::int) g`,
    [tenant, KEY, prefix, period_start, state, reserved_at, reserved_until, n],
  );
}

async function staleRow(pg: Client, tenant: string, send_key: string, period_start: string): Promise<void> {
  await pg.query(
    `INSERT INTO subscription."AllowanceUsage" (id, tenant_id, allowance_key, send_key, period_start, state, origin, reserved_at, reserved_until)
     VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4::timestamptz, 'RESERVED', 'SEND', '2026-10-18T09:00:00Z', '2026-10-18T09:10:00Z')`,
    [tenant, KEY, send_key, period_start],
  );
}

/** Seed the corpus. Runs on the PRE-A4 schema: no product_key column is named. */
export async function seedCorpus(pg: Client): Promise<void> {
  for (const s of SUBS) {
    await pg.query(
      `INSERT INTO subscription."TenantSubscription"
         (id, tenant_id, plan_id, period_anchor, source, started_at, ended_at, created_by, status, billing_provider, billing_account_ref,
          billing_subscription_ref, current_period_end, cancel_at_period_end, grace_until, provider_state_at, activated_by,
          commitment_start, commitment_end, eligibility_state, eligibility_checked_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5, $4::timestamptz, $6::timestamptz, 'ccp-a4-corpus', $7, $8, $9,
               $10, $11::timestamptz, $12, $13::timestamptz, $14::timestamptz, $15, $16::timestamptz, $17::timestamptz, $18, $19::timestamptz)`,
      [
        SUB(s.n),
        T(s.n),
        PLAN[s.plan],
        s.anchor,
        s.source,
        s.ended_at ?? null,
        s.status ?? 'ACTIVE',
        s.billing === true ? 'STRIPE' : null,
        s.billing === true ? `cus_${s.n}` : null,
        s.billing === true ? `sub_${s.n}` : null,
        s.billing === true ? '2026-11-05T00:00:00Z' : null,
        s.cancel_at_period_end === true,
        s.grace_until ?? null,
        s.billing === true ? '2026-10-05T00:00:00Z' : null,
        s.activated_by ?? null,
        s.commitment === true ? s.anchor : null,
        s.commitment === true ? '2027-10-02T00:00:00Z' : null,
        s.eligibility_state ?? null,
        s.eligibility_state !== undefined ? '2026-10-10T00:00:00Z' : null,
      ],
    );
  }
  // T2: 79 this period (2026-10-15) and 5 in the prior period (no rollover).
  await usage(pg, T(2), 'cur', 79, 'CONSUMED', '2026-10-15T00:00:00Z', '2026-10-16T00:00:00Z');
  await usage(pg, T(2), 'prior', 5, 'CONSUMED', '2026-09-15T00:00:00Z', '2026-09-20T00:00:00Z');
  // T3: 80 → WARNING.
  await usage(pg, T(3), 'cur', 80, 'CONSUMED', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
  // T4: 96 consumed + 3 overdue reservations = 99 counted; 2 released (not counted).
  await usage(pg, T(4), 'cur', 96, 'CONSUMED', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
  await usage(pg, T(4), 'rel', 2, 'RELEASED', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
  for (const k of ['stale:acc', 'stale:not', 'stale:unk']) await staleRow(pg, T(4), k, '2026-10-01T00:00:00Z');
  // T5: 100 → EXHAUSTED.
  await usage(pg, T(5), 'cur', 100, 'CONSUMED', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
  // T6: unlimited, metered.
  await usage(pg, T(6), 'cur', 250, 'CONSUMED', '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z');
  // T12: Free Personal — 3 this month, 2 of them in the last 24 hours (day cap reached).
  await usage(pg, T(12), 'old', 1, 'CONSUMED', '2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z');
  await usage(pg, T(12), 'day1', 1, 'CONSUMED', '2026-10-01T00:00:00Z', '2026-10-18T09:00:00Z');
  await usage(pg, T(12), 'day2', 1, 'CONSUMED', '2026-10-01T00:00:00Z', '2026-10-18T10:00:00Z');
  // T14: day clamp (anchor Jan 31): the current period starts 2026-09-30.
  await usage(pg, T(14), 'cur', 3, 'CONSUMED', '2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z');
  // Storage capacity: T6 5 GiB active + 1 released; T13 1 KiB.
  await pg.query(
    `INSERT INTO subscription."CapacityUsage" (id, tenant_id, capacity_key, ref, quantity, state, created_at, released_at) VALUES
       (gen_random_uuid(), $1::uuid, $3, 'doc:a', 5368709120, 'ACTIVE', '2026-10-06T00:00:00Z', NULL),
       (gen_random_uuid(), $1::uuid, $3, 'doc:b', 100, 'RELEASED', '2026-10-06T00:00:00Z', '2026-10-07T00:00:00Z'),
       (gen_random_uuid(), $2::uuid, $3, 'doc:c', 1024, 'ACTIVE', '2026-10-06T00:00:00Z', NULL)`,
    [T(6), T(13), STORAGE],
  );
}

/** Row counts of the two tables A4 changes (MP-A2 N-8 evidence). */
export async function rowCounts(pg: Client): Promise<{ plan: number; subscription: number; subscription_open: number }> {
  const r = await pg.query(
    `SELECT (SELECT count(*)::int FROM subscription."Plan") AS plan,
            (SELECT count(*)::int FROM subscription."TenantSubscription") AS subscription,
            (SELECT count(*)::int FROM subscription."TenantSubscription" WHERE ended_at IS NULL) AS subscription_open`,
  );
  return r.rows[0];
}

/** The Sign operations the corpus observes, behind a thin adapter (only the adapter differs before/after A4). */
export interface SignOps {
  getStatus(tenant_id: string, allowance_key: string, at: Date): Promise<unknown>;
  reserve(input: { tenant_id: string; allowance_key: string; send_key: string; at: Date }): Promise<unknown>;
  consume(input: { tenant_id: string; allowance_key: string; send_key: string; usage_event_type: string; at: Date }): Promise<unknown>;
  release(input: { tenant_id: string; allowance_key: string; send_key: string; at: Date }): Promise<unknown>;
  staleReservations(tenant_id: string, allowance_key: string, at: Date): Promise<string[]>;
  resolveStale(input: { tenant_id: string; allowance_key: string; usage_event_type: string; outcome: (k: string) => Promise<'ACCEPTED' | 'NOT_ACCEPTED' | 'UNKNOWN'>; at: Date }): Promise<unknown>;
  recordHistorical(input: { tenant_id: string; allowance_key: string; send_key: string; sent_at: Date }): Promise<unknown>;
  capacityStatus(tenant_id: string, capacity_key: string): Promise<unknown>;
  capacityReserve(input: { tenant_id: string; capacity_key: string; ref: string; quantity: number; at: Date }): Promise<unknown>;
  capacityRelease(input: { tenant_id: string; capacity_key: string; ref: string; at: Date }): Promise<unknown>;
  account(tenant_id: string, allowance_key: string, at: Date): Promise<unknown>;
  sendingOwner(tenant_id: string, at: Date): Promise<unknown>;
}

/** JSON-normalize (Dates → ISO, BigInt → string) so the observation compares byte-for-byte. */
export function normalize(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

/** Read, then mutate, every corpus tenant in a fixed order. The result is the N-13 observation. */
export async function observe(ops: SignOps): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const later = new Date('2026-10-18T12:30:00.000Z');
  for (const t of TENANTS) {
    const o: Record<string, unknown> = {};
    o['status'] = await ops.getStatus(t, KEY, AT);
    o['capacity'] = await ops.capacityStatus(t, STORAGE);
    o['account'] = await ops.account(t, KEY, AT);
    o['owner'] = await ops.sendingOwner(t, AT);
    o['stale'] = (await ops.staleReservations(t, KEY, AT)).sort();
    o['resolve'] = await ops.resolveStale({
      tenant_id: t,
      allowance_key: KEY,
      usage_event_type: EVENT,
      outcome: async (k) => (k === 'stale:acc' ? 'ACCEPTED' : k === 'stale:not' ? 'NOT_ACCEPTED' : 'UNKNOWN'),
      at: AT,
    });
    o['reserve_a'] = await ops.reserve({ tenant_id: t, allowance_key: KEY, send_key: 'n13:a', at: AT });
    o['reserve_a_retry'] = await ops.reserve({ tenant_id: t, allowance_key: KEY, send_key: 'n13:a', at: AT });
    o['consume_a'] = await ops.consume({ tenant_id: t, allowance_key: KEY, send_key: 'n13:a', usage_event_type: EVENT, at: AT });
    o['consume_a_retry'] = await ops.consume({ tenant_id: t, allowance_key: KEY, send_key: 'n13:a', usage_event_type: EVENT, at: AT });
    o['reserve_b'] = await ops.reserve({ tenant_id: t, allowance_key: KEY, send_key: 'n13:b', at: AT });
    o['release_b'] = await ops.release({ tenant_id: t, allowance_key: KEY, send_key: 'n13:b', at: AT });
    o['release_a_consumed'] = await ops.release({ tenant_id: t, allowance_key: KEY, send_key: 'n13:a', at: AT });
    o['reserve_b_again'] = await ops.reserve({ tenant_id: t, allowance_key: KEY, send_key: 'n13:b', at: later });
    o['historical'] = await ops.recordHistorical({ tenant_id: t, allowance_key: KEY, send_key: 'hist:1', sent_at: new Date('2026-09-20T00:00:00.000Z') });
    o['historical_retry'] = await ops.recordHistorical({ tenant_id: t, allowance_key: KEY, send_key: 'hist:1', sent_at: new Date('2026-09-20T00:00:00.000Z') });
    o['status_after'] = await ops.getStatus(t, KEY, later);
    o['capacity_reserve'] = await ops.capacityReserve({ tenant_id: t, capacity_key: STORAGE, ref: 'n13:doc', quantity: 2048, at: AT });
    o['capacity_reserve_retry'] = await ops.capacityReserve({ tenant_id: t, capacity_key: STORAGE, ref: 'n13:doc', quantity: 2048, at: AT });
    o['capacity_release'] = await ops.capacityRelease({ tenant_id: t, capacity_key: STORAGE, ref: 'n13:doc', at: AT });
    o['account_after'] = await ops.account(t, KEY, later);
    out[t] = normalize(o);
  }
  return out;
}
