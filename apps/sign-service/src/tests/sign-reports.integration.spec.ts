import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { EsignRepository, PrismaService, SignReportRepository } from '@aramo/sign';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Aramo-Sign-Feature-Parity-Program-Directive v1.0 (LOCKED, 2bd74ca5) §1.13 — the report
// queries against real Postgres 17 with the full sign migration chain (incl.
// 20261101150000_sign_report_indexes). Proves: tenant isolation, the sent-in-range cohort,
// turnaround percentiles, by-sender / by-template grouping, UTC volume buckets, deleted
// drafts excluded, the audit export's columns (no recipient identities) and its row cap.

const ROOT = resolve(__dirname, '../../../..');
const migrations = (): string[] => {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};
const HOUR = 3_600_000;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign reports — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let reports: SignReportRepository;
  const TENANT = randomUUID();
  const OTHER_TENANT = randomUUID();
  const ALICE = randomUUID();
  const BOB = randomUUID();
  const TPL = randomUUID();
  const RANGE = () => ({ tenant_id: TENANT, from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') });

  async function envelope(o: {
    tenant?: string;
    by: string;
    status: string;
    created: string;
    sent?: string;
    completedAfterHours?: number;
    declined?: string;
    voided?: string;
    template?: string;
    signers?: number;
  }): Promise<string> {
    const env = await repo.createEnvelope({ tenant_id: o.tenant ?? TENANT, subject: `Env ${o.status}`, execution_mode: 'SINGLE_SIGNATURE', created_by: o.by });
    for (let i = 1; i <= (o.signers ?? 1); i += 1) {
      await repo.addSigner({ tenant_id: o.tenant ?? TENANT, envelope_id: env.id, email: `s${i}@example.test`, name: `Signer ${i}`, signing_order: i });
    }
    const sent = o.sent === undefined ? null : new Date(o.sent);
    const completed = sent !== null && o.completedAfterHours !== undefined ? new Date(sent.getTime() + o.completedAfterHours * HOUR) : null;
    await db.query(
      `UPDATE "sign"."SignatureEnvelope" SET status = $2, created_at = $3, sent_at = $4, completed_at = $5, declined_at = $6, voided_at = $7 WHERE id = $1`,
      [env.id, o.status, new Date(o.created), sent, completed, o.declined === undefined ? null : new Date(o.declined), o.voided === undefined ? null : new Date(o.voided)],
    );
    if (o.template !== undefined) await db.query(`UPDATE "sign"."SignatureEnvelope" SET template_ref = $2, template_version_ref = $3 WHERE id = $1`, [env.id, o.template, randomUUID()]);
    if (o.status === 'COMPLETED') await db.query(`UPDATE "sign"."Signer" SET status = 'SIGNED' WHERE envelope_id = $1`, [env.id]);
    return env.id;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA identity; CREATE TABLE identity."Tenant" (id uuid PRIMARY KEY, legal_hold boolean NOT NULL DEFAULT false); CREATE TABLE identity."User" (id uuid PRIMARY KEY, email text)`);
    for (const m of migrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    repo = new EsignRepository(prisma);
    reports = new SignReportRepository(prisma);

    // In range (sent October 2026): Alice 3 (2 completed: 2h and 10h; 1 in flight), Bob 2 (1 declined, 1 voided).
    await envelope({ by: ALICE, status: 'COMPLETED', created: '2026-10-01T08:00:00Z', sent: '2026-10-01T09:00:00Z', completedAfterHours: 2, template: TPL, signers: 2 });
    await envelope({ by: ALICE, status: 'COMPLETED', created: '2026-10-10T08:00:00Z', sent: '2026-10-10T09:00:00Z', completedAfterHours: 10, template: TPL });
    await envelope({ by: ALICE, status: 'IN_PROGRESS', created: '2026-10-20T08:00:00Z', sent: '2026-10-20T09:00:00Z' });
    await envelope({ by: BOB, status: 'DECLINED', created: '2026-10-05T08:00:00Z', sent: '2026-10-05T09:00:00Z', declined: '2026-10-06T09:00:00Z' });
    await envelope({ by: BOB, status: 'VOIDED', created: '2026-10-07T08:00:00Z', sent: '2026-10-07T09:00:00Z', voided: '2026-10-08T09:00:00Z' });
    // Out of the cohort: sent in September, completed in October (counts in October's completed volume only).
    await envelope({ by: BOB, status: 'COMPLETED', created: '2026-09-28T08:00:00Z', sent: '2026-09-29T09:00:00Z', completedAfterHours: 72 });
    // A draft created in October (audit export only), and a deleted draft (never counted).
    await envelope({ by: ALICE, status: 'DRAFT', created: '2026-10-15T08:00:00Z' });
    const deleted = await envelope({ by: ALICE, status: 'DRAFT', created: '2026-10-16T08:00:00Z' });
    await db.query(`UPDATE "sign"."SignatureEnvelope" SET deleted_at = now() WHERE id = $1`, [deleted]);
    // Another tenant's envelope in the same window (never visible).
    await envelope({ tenant: OTHER_TENANT, by: randomUUID(), status: 'COMPLETED', created: '2026-10-03T08:00:00Z', sent: '2026-10-03T09:00:00Z', completedAfterHours: 1 });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('the cohort counts envelopes SENT in the range, for this tenant only, with turnaround stats', async () => {
    const c = await reports.cohort(RANGE());
    expect(c).toEqual({
      sent: 5,
      completed: 2,
      declined: 1,
      voided: 1,
      expired: 0,
      in_flight: 1,
      turnaround_avg_seconds: 6 * 3600,
      turnaround_median_seconds: 6 * 3600,
      turnaround_p90_seconds: expect.closeTo(9.2 * 3600, 3),
    });
  });

  it('groups the cohort by sender and by template (null = not from a template)', async () => {
    const bySender = await reports.cohortBy(RANGE(), 'sender');
    expect(bySender.map((s) => [s.key, s.sent, s.completed, s.declined, s.voided, s.in_flight])).toEqual([
      [ALICE, 3, 2, 0, 0, 1],
      [BOB, 2, 0, 1, 1, 0],
    ]);
    const byTemplate = await reports.cohortBy(RANGE(), 'template');
    expect(byTemplate.map((t) => [t.key, t.sent, t.completed])).toEqual([
      [null, 3, 0],
      [TPL, 2, 2],
    ]);
  });

  it('volume counts each event in its own UTC period', async () => {
    const weeks = await reports.volume(RANGE(), 'week');
    const total = (k: 'sent' | 'completed' | 'declined' | 'voided') => weeks.reduce((a, w) => a + w[k], 0);
    expect([total('sent'), total('completed'), total('declined'), total('voided')]).toEqual([5, 3, 1, 1]);
    expect(weeks[0]?.period_start.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    const months = await reports.volume(RANGE(), 'month');
    expect(months).toEqual([{ period_start: new Date('2026-10-01T00:00:00.000Z'), sent: 5, completed: 3, declined: 1, voided: 1 }]);
  });

  it('the audit export lists envelopes CREATED in the range (deleted drafts excluded) with counts only', async () => {
    const rows = await reports.auditEnvelopes(RANGE(), 100);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.status)).toEqual(['IN_PROGRESS', 'DRAFT', 'COMPLETED', 'VOIDED', 'DECLINED', 'COMPLETED']);
    const first = rows[rows.length - 1];
    expect(first).toMatchObject({ created_by: ALICE, template_ref: TPL, recipients: 2, signed: 2, purge_state: null });
    expect(Object.keys(first ?? {})).not.toEqual(expect.arrayContaining(['email']));
    expect(await reports.auditEnvelopes(RANGE(), 2)).toHaveLength(2);
  });

  it('a range with nothing in it returns zeros, not errors', async () => {
    const empty = { tenant_id: TENANT, from: new Date('2025-01-01T00:00:00Z'), to: new Date('2025-02-01T00:00:00Z') };
    expect(await reports.cohort(empty)).toMatchObject({ sent: 0, completed: 0, turnaround_median_seconds: null });
    expect(await reports.cohortBy(empty, 'sender')).toEqual([]);
    expect(await reports.volume(empty, 'day')).toEqual([]);
  });

  it('the report indexes exist', async () => {
    const r = await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'sign' AND tablename = 'SignatureEnvelope' AND indexname LIKE 'SignatureEnvelope_tenant_%_at_idx' ORDER BY 1`);
    expect(r.rows.map((x: { indexname: string }) => x.indexname)).toEqual(['SignatureEnvelope_tenant_created_at_idx', 'SignatureEnvelope_tenant_sent_at_idx']);
  });
});
