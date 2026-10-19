import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AllowanceService } from '../lib/allowance.service.js';
import { openDevelopmentSubscription } from '../lib/development-subscription.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// Multi-Provider directive §C — the transactional allowance invariants, proven on
// real Postgres 17: 99/100 concurrency, idempotency, release, stale resolution,
// period boundaries (no rollover), tenant isolation and the metering event.

const MIGRATIONS = [
  '../../../metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20261018120000_init_subscription_allowance/migration.sql',
  '../../prisma/migrations/20261019100000_subscription_lifecycle_billing/migration.sql',
].map((p) => resolve(__dirname, p));

const KEY = 'esign.envelopes';
const EVENT = 'esign.envelope.sent';
const ANCHOR = new Date('2026-10-01T00:00:00.000Z');
const IN_PERIOD = new Date('2026-10-18T12:00:00.000Z');
const TEST_ENV = { ARAMO_ENV: 'test' };
let seq = 0;
const tenant = () => `0190aaaa-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('subscription — allowance ledger (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let svc: AllowanceService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    for (const m of MIGRATIONS) await pg.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    svc = new AllowanceService(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  let t: string;
  beforeEach(async () => {
    t = tenant();
    await openDevelopmentSubscription(prisma, { tenant_id: t, period_anchor: ANCHOR, created_by: 'test' }, TEST_ENV);
  });

  async function fill(n: number, tenant_id = t, prefix = 'fill'): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      const send_key = `${prefix}:${i}`;
      expect((await svc.reserve({ tenant_id, allowance_key: KEY, send_key, at: IN_PERIOD })).ok).toBe(true);
      expect(await svc.consume({ tenant_id, allowance_key: KEY, send_key, usage_event_type: EVENT, at: IN_PERIOD })).toBe('CONSUMED');
    }
  }

  it('the plan allowance is catalog data (100) and the read reports plan, period and use', async () => {
    const s = await svc.getStatus(t, KEY, IN_PERIOD);
    expect(s).toMatchObject({ subscribed: true, plan_key: 'aramo-sign-included-v1', limit: 100, used: 0, remaining: 100, threshold: 'OK' });
    expect(s.subscribed && s.period_start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(s.subscribed && s.period_end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('a tenant without a subscription is refused NOT_SUBSCRIBED', async () => {
    const r = await svc.reserve({ tenant_id: tenant(), allowance_key: KEY, send_key: 'x', at: IN_PERIOD });
    expect(r).toMatchObject({ ok: false, reason: 'NOT_SUBSCRIBED' });
  });

  it('warns at 80, exhausts at 100 and refuses the 101st send', async () => {
    await fill(80);
    expect(await svc.getStatus(t, KEY, IN_PERIOD)).toMatchObject({ used: 80, threshold: 'WARNING' });
    await fill(20, t, 'more');
    expect(await svc.getStatus(t, KEY, IN_PERIOD)).toMatchObject({ used: 100, remaining: 0, threshold: 'EXHAUSTED' });
    const r = await svc.reserve({ tenant_id: t, allowance_key: KEY, send_key: 'over', at: IN_PERIOD });
    expect(r).toMatchObject({ ok: false, reason: 'LIMIT_REACHED' });
  }, 60_000);

  it('at 99/100, ten simultaneous sends: exactly one gets the last envelope', async () => {
    await fill(99);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => svc.reserve({ tenant_id: t, allowance_key: KEY, send_key: `race:${i}`, at: IN_PERIOD })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'LIMIT_REACHED')).toHaveLength(9);
    expect(await svc.getStatus(t, KEY, IN_PERIOD)).toMatchObject({ used: 100 });
  }, 60_000);

  it('retries and duplicate events never charge twice, and write one usage event', async () => {
    const k = { tenant_id: t, allowance_key: KEY, send_key: 'env-1' };
    expect(await svc.reserve({ ...k, at: IN_PERIOD })).toMatchObject({ ok: true, already: false });
    expect(await svc.reserve({ ...k, at: IN_PERIOD })).toMatchObject({ ok: true, already: true });
    expect(await svc.consume({ ...k, usage_event_type: EVENT })).toBe('CONSUMED');
    expect(await svc.consume({ ...k, usage_event_type: EVENT })).toBe('ALREADY');
    expect(await svc.reserve({ ...k, at: IN_PERIOD })).toMatchObject({ ok: true, already: true });
    expect(await svc.getStatus(t, KEY, IN_PERIOD)).toMatchObject({ used: 1 });
    const ev = await pg.query('SELECT count(*)::int AS n FROM metering."UsageEvent" WHERE tenant_id = $1 AND event_type = $2', [t, EVENT]);
    expect(ev.rows[0].n).toBe(1);
  });

  it('a send that failed before acceptance is released; a consumed send is never released', async () => {
    await fill(99);
    const k = { tenant_id: t, allowance_key: KEY, send_key: 'fails' };
    expect((await svc.reserve({ ...k, at: IN_PERIOD })).ok).toBe(true);
    expect(await svc.release(k)).toBe(true);
    expect(await svc.getStatus(t, KEY, IN_PERIOD)).toMatchObject({ used: 99 });
    expect(await svc.release({ ...k, send_key: 'fill:0' })).toBe(false);
    expect(await svc.getStatus(t, KEY, IN_PERIOD)).toMatchObject({ used: 99 });
    // The released send may be retried and then counts once.
    expect(await svc.reserve({ ...k, at: IN_PERIOD })).toMatchObject({ ok: true, already: false });
    expect(await svc.getStatus(t, KEY, IN_PERIOD)).toMatchObject({ used: 100 });
  }, 60_000);

  it('an overdue reservation keeps counting until resolved: accepted → consumed, not accepted → released, unknown → held', async () => {
    const at = IN_PERIOD;
    for (const s of ['acc', 'rej', 'unk']) {
      await svc.reserve({ tenant_id: t, allowance_key: KEY, send_key: s, at, ttl_ms: 1000 });
    }
    expect(await svc.getStatus(t, KEY, at)).toMatchObject({ used: 3 });
    const later = new Date(at.getTime() + 60_000);
    const outcomes: Record<string, 'ACCEPTED' | 'NOT_ACCEPTED' | 'UNKNOWN'> = { acc: 'ACCEPTED', rej: 'NOT_ACCEPTED', unk: 'UNKNOWN' };
    const tally = await svc.resolveStale({ tenant_id: t, allowance_key: KEY, usage_event_type: EVENT, outcome: async (k) => outcomes[k] ?? 'UNKNOWN', at: later });
    expect(tally).toEqual({ consumed: 1, released: 1, unknown: 1 });
    expect(await svc.getStatus(t, KEY, later)).toMatchObject({ used: 2 });
  });

  it('the next billing period starts at 0 (no rollover) and old usage stays in its period', async () => {
    await fill(100);
    const next = new Date('2026-11-01T00:00:00.000Z');
    expect(await svc.getStatus(t, KEY, next)).toMatchObject({ used: 0, remaining: 100, threshold: 'OK' });
    expect((await svc.reserve({ tenant_id: t, allowance_key: KEY, send_key: 'november', at: next })).ok).toBe(true);
    expect(await svc.getStatus(t, KEY, IN_PERIOD)).toMatchObject({ used: 100 });
  }, 60_000);

  it('tenants are isolated', async () => {
    await fill(100);
    const other = tenant();
    await openDevelopmentSubscription(prisma, { tenant_id: other, period_anchor: ANCHOR, created_by: 'test' }, TEST_ENV);
    expect((await svc.reserve({ tenant_id: other, allowance_key: KEY, send_key: 'fill:0', at: IN_PERIOD })).ok).toBe(true);
    expect(await svc.getStatus(t, KEY, IN_PERIOD)).toMatchObject({ used: 100 });
    expect(await svc.getStatus(other, KEY, IN_PERIOD)).toMatchObject({ used: 1 });
  }, 60_000);

  it('historical sends reconcile once into their own period', async () => {
    const sent_at = new Date('2026-10-05T09:00:00.000Z');
    expect(await svc.recordHistorical({ tenant_id: t, allowance_key: KEY, send_key: 'old-env', sent_at })).toBe(true);
    expect(await svc.recordHistorical({ tenant_id: t, allowance_key: KEY, send_key: 'old-env', sent_at })).toBe(false);
    expect(await svc.getStatus(t, KEY, IN_PERIOD)).toMatchObject({ used: 1 });
  });

  it('one open subscription per tenant; the development seed is idempotent', async () => {
    const again = await openDevelopmentSubscription(prisma, { tenant_id: t, created_by: 'test' }, TEST_ENV);
    expect(again.created).toBe(false);
    await expect(
      pg.query(
        `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, period_anchor, source, created_by)
         VALUES (gen_random_uuid(), $1, '019a0000-5150-7000-8000-000000000001', now(), 'MANUAL', 'x')`,
        [t],
      ),
    ).rejects.toThrow(/one_open_per_tenant/);
  });
});
