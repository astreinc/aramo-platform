import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AllowanceService, DAY_WINDOW_MS } from '../lib/allowance.service.js';
import { openDevelopmentSubscription } from '../lib/development-subscription.js';
import { FreePersonalPlanKey, FreePersonalSubscriptionService, personalSignupMode } from '../lib/free-personal-subscription.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { CCP_A4_MIGRATION } from './fixtures/ccp-a4.js';
import { CCP_A5_MIGRATION } from './fixtures/ccp-a5.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED §1 / §4 — on real Postgres 17:
// the FREE subscription opens only for an ACTIVE PERSONAL tenant while the mode is
// not off, carries no billing linkage (no provider is ever called — the service
// has no billing dependency and a CHECK forbids linkage), and the Free Personal
// plan enforces 5 per monthly period AND at most 2 in any 24 hours, one envelope
// counting once. Plans without a day window (Business / ATS) are unchanged.

const MIGRATIONS = [
  '../../../metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20261018120000_init_subscription_allowance/migration.sql',
  '../../prisma/migrations/20261019100000_subscription_lifecycle_billing/migration.sql',
  '../../prisma/migrations/20261019140000_sign_commercial_catalog_a1/migration.sql',
  '../../prisma/migrations/20261020130300_sign_naming_keys/migration.sql',
  '../../prisma/migrations/20261022100100_billing_account_country_guard/migration.sql',
  '../../prisma/migrations/20261022110100_billing_flag_domain_reason/migration.sql',
  '../../prisma/migrations/20261023100000_sign_personal_free/migration.sql',
].map((p) => resolve(__dirname, p)).concat(CCP_A4_MIGRATION, CCP_A5_MIGRATION);

const KEY = 'sign.envelopes';
const EVENT = 'sign.envelope.sent';
const ANCHOR = new Date('2026-10-01T00:00:00.000Z');
const HOUR = 3_600_000;
let seq = 0;
const tenant = () => `0190bbbb-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('subscription — Free Personal (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let allowance: AllowanceService;
  let free: FreePersonalSubscriptionService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    for (const m of MIGRATIONS) await pg.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    allowance = new AllowanceService(prisma);
    free = new FreePersonalSubscriptionService(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  const open = (tenant_id: string, over: Partial<{ tenant_kind: string; tenant_status: string; mode: 'off' | 'invite' | 'open' }> = {}) =>
    free.ensure({ product_key: 'sign', tenant_id, tenant_kind: 'PERSONAL', tenant_status: 'ACTIVE', mode: 'invite', at: ANCHOR, ...over });

  async function send(tenant_id: string, envelope: string, at: Date) {
    const send_key = `aramo-sign:envelope:${envelope}`;
    const r = await allowance.reserve({ product_key: 'sign', tenant_id, allowance_key: KEY, send_key, at });
    if (r.ok) await allowance.consume({ product_key: 'sign', tenant_id, allowance_key: KEY, send_key, usage_event_type: EVENT, at });
    return r;
  }

  it('the mode helper fails closed to off', () => {
    expect(personalSignupMode({})).toBe('off');
    expect(personalSignupMode({ SIGN_PERSONAL_SIGNUP_MODE: 'OFF' })).toBe('off');
    expect(personalSignupMode({ SIGN_PERSONAL_SIGNUP_MODE: 'bogus' })).toBe('off');
    expect(personalSignupMode({ SIGN_PERSONAL_SIGNUP_MODE: 'invite' })).toBe('invite');
    expect(personalSignupMode({ SIGN_PERSONAL_SIGNUP_MODE: ' open ' })).toBe('open');
  });

  it('opens FREE only for an ACTIVE PERSONAL tenant with the mode not off; nothing is written otherwise', async () => {
    const t = tenant();
    expect(await open(t, { mode: 'off' })).toEqual({ ok: false, reason: 'personal_mode_off' });
    expect(await open(t, { tenant_kind: 'BUSINESS' })).toEqual({ ok: false, reason: 'tenant_not_personal' });
    expect(await open(t, { tenant_status: 'PROVISIONED' })).toEqual({ ok: false, reason: 'tenant_not_active' });
    expect(await prisma.tenantSubscription.count({ where: { tenant_id: t } })).toBe(0);

    const r = await open(t);
    expect(r).toMatchObject({ ok: true, opened: true, source: 'FREE' });
    const row = await prisma.tenantSubscription.findFirstOrThrow({ where: { tenant_id: t }, include: { plan: true } });
    expect(row).toMatchObject({ source: 'FREE', status: 'ACTIVE', billing_provider: null, billing_account_ref: null, billing_subscription_ref: null, ended_at: null });
    expect(row.plan.key).toBe(FreePersonalPlanKey);
    // The catalog row is untouched: never sellable, still INACTIVE (FREE is a system act).
    expect(row.plan).toMatchObject({ sellable: false, status: 'INACTIVE', sales_model: 'FREE' });
    // Idempotent: a second read keeps the same row.
    expect(await open(t)).toMatchObject({ ok: true, opened: false, subscription_id: row.id });
    expect(await prisma.tenantSubscription.count({ where: { tenant_id: t } })).toBe(1);
  });

  it('concurrent first reads open exactly one FREE subscription', async () => {
    const t = tenant();
    const rs = await Promise.all([open(t), open(t), open(t)]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(await prisma.tenantSubscription.count({ where: { tenant_id: t } })).toBe(1);
  });

  it('a tenant with another open subscription keeps it (no FREE row)', async () => {
    const t = tenant();
    await openDevelopmentSubscription(prisma, { product_key: 'sign', tenant_id: t, period_anchor: ANCHOR, created_by: 'test' }, { ARAMO_ENV: 'test' });
    expect(await open(t)).toMatchObject({ ok: true, opened: false, source: 'DEVELOPMENT' });
  });

  it('the CHECK refuses billing linkage on a FREE row', async () => {
    const t = tenant();
    await open(t);
    await expect(
      pg.query(`UPDATE subscription."TenantSubscription" SET billing_provider = 'STRIPE', billing_account_ref = 'acct_x' WHERE tenant_id = $1`, [t]),
    ).rejects.toThrow(/TenantSubscription_free_unbilled_check/);
  });

  it('enforces at most 2 in any 24 hours, one envelope counted once', async () => {
    const t = tenant();
    await open(t);
    const day1 = new Date('2026-10-05T09:00:00.000Z');
    expect((await send(t, 'e1', day1)).ok).toBe(true);
    // The same envelope retried never charges twice.
    const again = await send(t, 'e1', new Date(day1.getTime() + 60_000));
    expect(again).toMatchObject({ ok: true, already: true });
    expect((await send(t, 'e2', new Date(day1.getTime() + HOUR))).ok).toBe(true);
    const third = await send(t, 'e3', new Date(day1.getTime() + 2 * HOUR));
    expect(third).toMatchObject({ ok: false, reason: 'DAILY_LIMIT_REACHED' });
    const st = third.ok ? null : third.status;
    expect(st?.subscribed && st.daily).toMatchObject({ window: 'DAY', limit: 2, used: 2, remaining: 0 });
    expect(st?.subscribed && st.daily?.next_available_at?.toISOString()).toBe(new Date(day1.getTime() + DAY_WINDOW_MS).toISOString());
    // A rolling 24-hour window: once e1 is 24 h old a slot frees (calendar midnight resets nothing).
    expect((await send(t, 'e3', new Date(day1.getTime() + DAY_WINDOW_MS + 1000))).ok).toBe(true);
    const status = await allowance.getStatus(t, 'sign', KEY, new Date(day1.getTime() + DAY_WINDOW_MS + 2000));
    expect(status).toMatchObject({ subscribed: true, plan_key: FreePersonalPlanKey, limit: 5, used: 3, remaining: 2 });
  });

  it('enforces 5 per monthly period across days, then refuses LIMIT_REACHED', async () => {
    const t = tenant();
    await open(t);
    const days = [2, 4, 6, 8, 10].map((d) => new Date(`2026-10-${String(d).padStart(2, '0')}T10:00:00.000Z`));
    for (const [i, at] of days.entries()) expect((await send(t, `m${i}`, at)).ok).toBe(true);
    const sixth = await send(t, 'm5', new Date('2026-10-20T10:00:00.000Z'));
    expect(sixth).toMatchObject({ ok: false, reason: 'LIMIT_REACHED' });
    // The next anniversary period starts fresh.
    expect((await send(t, 'm6', new Date('2026-11-02T10:00:00.000Z'))).ok).toBe(true);
  });

  it('a released (failed) send does not count toward the day window', async () => {
    const t = tenant();
    await open(t);
    const at = new Date('2026-10-12T10:00:00.000Z');
    const k = 'aramo-sign:envelope:r1';
    expect((await allowance.reserve({ product_key: 'sign', tenant_id: t, allowance_key: KEY, send_key: k, at })).ok).toBe(true);
    expect(await allowance.release({ product_key: 'sign', tenant_id: t, allowance_key: KEY, send_key: k, at })).toBe(true);
    expect((await send(t, 'r2', at)).ok).toBe(true);
    expect((await send(t, 'r3', at)).ok).toBe(true);
  });

  it('plans without a day window (operator / Business) have no daily cap and no daily field', async () => {
    const t = tenant();
    await openDevelopmentSubscription(prisma, { product_key: 'sign', tenant_id: t, period_anchor: ANCHOR, created_by: 'test' }, { ARAMO_ENV: 'test' });
    const at = new Date('2026-10-05T09:00:00.000Z');
    for (let i = 0; i < 4; i += 1) expect((await send(t, `b${i}`, at)).ok).toBe(true);
    const s = await allowance.getStatus(t, 'sign', KEY, at);
    expect(s.subscribed && 'daily' in s).toBe(false);
    const b = tenant();
    const business = await prisma.plan.findUniqueOrThrow({ where: { key: 'aramo-sign-standard-business-v1' } });
    await prisma.tenantSubscription.create({
      data: {
        id: `0190cccc-0000-7000-8000-${String(++seq).padStart(12, '0')}`,
        tenant_id: b,
        plan_id: business.id,
        // CCP-A5 — the pin is named explicitly (no DB default).
        plan_version_id: (await prisma.planVersion.findFirstOrThrow({ where: { plan_id: business.id, status: 'PUBLISHED' } })).id,
        product_key: 'sign',
        composition_role: 'BASE',
        period_anchor: ANCHOR,
        source: 'MANUAL',
        created_by: 'test',
      },
    });
    for (let i = 0; i < 3; i += 1) expect((await send(b, `sb${i}`, at)).ok).toBe(true);
    expect(await prisma.planAllowanceWindow.count()).toBe(1);
  });
});
