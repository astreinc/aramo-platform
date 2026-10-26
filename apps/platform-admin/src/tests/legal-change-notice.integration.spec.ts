import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { IdentityRepository, PrismaService as IdentityPrismaService } from '@aramo/identity';
import { MAILER_PORT } from '@aramo/mailer';
import {
  LEGAL_CHANGE_NOTICE_TEMPLATE,
  LegalChangeNoticeRefusedError,
  LegalChangeNoticeRepository,
  LegalChangeNoticeService,
  SubscriptionPrismaService,
  templateSha256,
  type AccountHolderSource,
  type LegalChangeNoticeRunOptions,
  type LegalNoticeMailer,
} from '@aramo/subscription';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LegalChangeNoticeCliModule } from '../app/legal-notice/legal-change-notice-cli.module.js';

// Privacy Notice 1.1 remediation E-6 — the account-holder change notice on REAL Postgres 17 with
// every identity, entitlement, metering and subscription migration applied whole-file, the real
// IdentityRepository enumeration and the real evidence repository; only the mailer is a capturing
// fake. Proves:
//   - recipient enumeration across tenants (BUSINESS, PERSONAL, the platform tenant), excluding
//     deactivated users, deactivated or not-yet-accepted memberships, and closed or inactive
//     tenants; the PERSONAL audience; keyset paging; zero, one and many tenants;
//   - dry run sends nothing and writes no delivery row (the run row carries the counts);
//   - send refused while the template is DRAFT without the exact confirmation, or with no
//     authorization reference (nothing written);
//   - idempotency (a second run sends nothing), evidence rows (status, provider message id,
//     template id/version/sha, tenant), one recipient per email;
//   - partial failure then resume (only the failed are retried);
//   - an interrupted run leaves its recipient "in doubt", skipped unless --resend-in-doubt;
//   - in-service evidence is per user (tenant isolation); the evidence trigger refuses deletes
//     and changes to a delivered row; rate limiting; the CLI module wiring.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const NOW = new Date('2026-10-26T12:00:00.000Z');
const EFFECTIVE = '2026-11-25';
const APPROVED = `${LEGAL_CHANGE_NOTICE_TEMPLATE.id}@${LEGAL_CHANGE_NOTICE_TEMPLATE.version}`;
// One summary per test version, so each scenario has its own idempotency key space.
const SUMMARIES: Record<string, readonly string[]> = Object.fromEntries(
  ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7'].map((v) => [`aramo.privacy_notice@${v}`, [`Test change ${v}.`]]),
);
SUMMARIES['sign.personal_terms_of_service@1.1'] = ['Personal test change.'];

interface Sent {
  to: string;
  subject: string;
}

class CapturingMailer implements LegalNoticeMailer {
  readonly sent: Sent[] = [];
  constructor(private readonly failFor: ReadonlySet<string> = new Set()) {}
  async send(a: { to: string; subject: string; html: string; text?: string }): Promise<{ message_id: string }> {
    if (this.failFor.has(a.to)) throw Object.assign(new Error(`rejected ${a.to}`), { name: 'MessageRejected' });
    this.sent.push({ to: a.to, subject: a.subject });
    return { message_id: `msg-${randomUUID()}` };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('legal change notice — account holders, sending and evidence (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let url: string;
  let identity: IdentityRepository;
  let repo: LegalChangeNoticeRepository;
  const prismas: { $disconnect(): Promise<void> }[] = [];
  const users: Record<string, { id: string; tenant: string; email: string }> = {};
  let sleeps: number[] = [];

  async function tenant(name: string, kind: 'BUSINESS' | 'PERSONAL', opts: { status?: string; is_active?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,$2,$3,$4,$5,$6, now())`, [
      id,
      name,
      `t-${id.slice(0, 8)}`,
      kind,
      opts.status ?? 'ACTIVE',
      opts.is_active ?? true,
    ]);
    return id;
  }

  async function user(label: string, tenant_id: string, opts: { user_active?: boolean; user_deactivated?: boolean; membership_active?: boolean; invite_status?: string } = {}): Promise<void> {
    const id = randomUUID();
    const email = `${label}-${id.slice(0, 6)}@example.com`;
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, is_active, deactivated_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6, now())`, [
      id,
      email,
      label,
      tenant_id,
      opts.user_active ?? true,
      opts.user_deactivated === true ? new Date() : null,
    ]);
    const membershipActive = opts.membership_active ?? true;
    await db.query(
      `INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, is_active, invite_status, deactivated_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6, now())`,
      [randomUUID(), id, tenant_id, membershipActive, opts.invite_status ?? 'ACTIVE', membershipActive ? null : new Date()],
    );
    users[label] = { id, tenant: tenant_id, email };
  }

  const holders = (): AccountHolderSource => ({ activeAccountHolders: (a) => identity.listActiveAccountHolders(a) });
  const service = (mailer: LegalNoticeMailer, over: { holders?: AccountHolderSource; repository?: LegalChangeNoticeRepository } = {}) =>
    new LegalChangeNoticeService({
      repository: over.repository ?? repo,
      holders: over.holders ?? holders(),
      mailer,
      provider: 'stub',
      now: () => NOW,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      summaries: SUMMARIES,
    });
  const opts = (version: string, over: Partial<LegalChangeNoticeRunOptions> = {}): LegalChangeNoticeRunOptions => ({
    mode: 'SEND',
    document_key: 'aramo.privacy_notice',
    version,
    effective_date: EFFECTIVE,
    approved_template: APPROVED,
    authorization_ref: 'TEST-AUTH-1',
    rate_per_second: 2,
    resend_in_doubt: false,
    ...over,
  });
  const deliveries = async (version: string, document_key = 'aramo.privacy_notice') =>
    (
      await db.query(
        `SELECT user_id, tenant_id, channel, status, provider, provider_message_id, error_code, attempt_count, template_id, template_version, template_sha256, run_id, sent_at, effective_date::text AS effective_date
           FROM subscription."LegalChangeNoticeDelivery" WHERE document_key = $1 AND version = $2 ORDER BY user_id`,
        [document_key, version],
      )
    ).rows as {
      user_id: string;
      tenant_id: string;
      channel: string;
      status: string;
      provider: string | null;
      provider_message_id: string | null;
      error_code: string | null;
      attempt_count: number;
      template_id: string;
      template_version: string;
      template_sha256: string;
      run_id: string;
      sent_at: Date | null;
      effective_date: string;
    }[];
  const run = async (id: string) => (await db.query(`SELECT * FROM subscription."LegalChangeNoticeRun" WHERE id = $1`, [id])).rows[0];

  const ELIGIBLE = ['b1-owner', 'b1-member', 'b2-owner', 'b2-accepted', 'personal', 'platform-operator'];

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['identity', 'entitlement', 'metering', 'subscription']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    const b1 = await tenant('Business One', 'BUSINESS');
    const b2 = await tenant('Business Two', 'BUSINESS', { status: 'SUSPENDED' });
    const p1 = await tenant('Personal', 'PERSONAL');
    const platform = await tenant('Aramo Platform', 'BUSINESS');
    const closed = await tenant('Closed', 'BUSINESS', { status: 'CLOSED' });
    const inactive = await tenant('Inactive', 'PERSONAL', { is_active: false });
    await user('b1-owner', b1);
    await user('b1-member', b1);
    await user('b1-user-deactivated', b1, { user_active: false, user_deactivated: true });
    await user('b1-membership-off', b1, { membership_active: false });
    await user('b1-invited', b1, { invite_status: 'INVITED' });
    await user('b2-owner', b2);
    await user('b2-accepted', b2, { invite_status: 'ACCEPTED' });
    await user('personal', p1);
    await user('platform-operator', platform);
    await user('closed-owner', closed);
    await user('inactive-owner', inactive);

    const idp = new IdentityPrismaService(url);
    const subp = new SubscriptionPrismaService(url);
    prismas.push(idp, subp);
    identity = new IdentityRepository(idp);
    repo = new LegalChangeNoticeRepository(subp);
  }, 240_000);

  afterAll(async () => {
    for (const p of prismas) await p.$disconnect().catch(() => undefined);
    await db?.end();
    await container?.stop();
  });

  describe('recipient enumeration', () => {
    it('lists every active account holder across tenants, and no one else', async () => {
      const all = await identity.listActiveAccountHolders({ after_user_id: null, limit: 100, audience: 'ALL' });
      expect(all.map((h) => h.user_id).sort()).toEqual(ELIGIBLE.map((l) => users[l]!.id).sort());
      for (const h of all) {
        const u = Object.values(users).find((x) => x.id === h.user_id)!;
        expect(h.tenant_id).toBe(u.tenant);
        expect(h.email).toBe(u.email);
      }
      expect(new Set(all.map((h) => h.tenant_id)).size).toBe(4);
    });

    it('the PERSONAL audience is Personal accounts only (one tenant)', async () => {
      const personal = await identity.listActiveAccountHolders({ after_user_id: null, limit: 100, audience: 'PERSONAL' });
      expect(personal.map((h) => h.user_id)).toEqual([users['personal']!.id]);
      expect(personal[0]!.tenant_kind).toBe('PERSONAL');
    });

    it('keyset paging returns the same set, in user_id order, without repeats', async () => {
      const seen: string[] = [];
      let after: string | null = null;
      for (;;) {
        const page = await identity.listActiveAccountHolders({ after_user_id: after, limit: 2, audience: 'ALL' });
        seen.push(...page.map((h) => h.user_id));
        if (page.length < 2) break;
        after = page[page.length - 1]!.user_id;
      }
      expect(seen).toEqual([...seen].sort());
      expect(seen.sort()).toEqual(ELIGIBLE.map((l) => users[l]!.id).sort());
    });
  });

  describe('dry run', () => {
    it('counts recipients, sends nothing and writes no delivery row', async () => {
      const mailer = new CapturingMailer();
      const r = await service(mailer).run(opts('1.1', { mode: 'DRY_RUN', approved_template: null, authorization_ref: null }));
      expect(r.eligible_count).toBe(6);
      expect(r.would_send_count).toBe(6);
      expect(r.sent_count).toBe(0);
      expect(mailer.sent).toEqual([]);
      expect(await deliveries('1.1')).toEqual([]);
      const row = await run(r.run_id);
      expect(row).toMatchObject({ mode: 'DRY_RUN', status: 'COMPLETED', eligible_count: 6, sent_count: 0, template_status: 'DRAFT', authorization_ref: null });
    });

    it('a dry run of a Personal-only document counts one recipient', async () => {
      const r = await service(new CapturingMailer()).run({
        ...opts('1.1', { mode: 'DRY_RUN', approved_template: null, authorization_ref: null }),
        document_key: 'sign.personal_terms_of_service',
      });
      expect(r.eligible_count).toBe(1);
    });

    it('zero recipients (no tenants) completes with zero counts', async () => {
      const mailer = new CapturingMailer();
      const r = await service(mailer, { holders: { activeAccountHolders: async () => [] } }).run(opts('1.7'));
      expect(r).toMatchObject({ eligible_count: 0, sent_count: 0, failed_count: 0 });
      expect((await run(r.run_id)).status).toBe('COMPLETED');
      expect(mailer.sent).toEqual([]);
    });
  });

  describe('send guards', () => {
    it('refuses a DRAFT template without the exact confirmation, and a send with no authorization reference — nothing written', async () => {
      const before = Number((await db.query(`SELECT count(*) FROM subscription."LegalChangeNoticeRun"`)).rows[0].count);
      const mailer = new CapturingMailer();
      await expect(service(mailer).run(opts('1.1', { approved_template: null }))).rejects.toMatchObject({ refusal: 'template_draft' });
      await expect(service(mailer).run(opts('1.1', { approved_template: 'aramo.legal_change_notice@9.9.9' }))).rejects.toMatchObject({ refusal: 'template_mismatch' });
      await expect(service(mailer).run(opts('1.1', { authorization_ref: '  ' }))).rejects.toBeInstanceOf(LegalChangeNoticeRefusedError);
      await expect(service(mailer).run(opts('1.1', { effective_date: '2026-11-24' }))).rejects.toMatchObject({ refusal: 'notice_period_too_short' });
      expect(Number((await db.query(`SELECT count(*) FROM subscription."LegalChangeNoticeRun"`)).rows[0].count)).toBe(before);
      expect(mailer.sent).toEqual([]);
      expect(await deliveries('1.1')).toEqual([]);
    });
  });

  describe('send, evidence and idempotency', () => {
    it('sends one email per account holder and records the evidence', async () => {
      const mailer = new CapturingMailer();
      sleeps = [];
      const r = await service(mailer).run(opts('1.1'));
      expect(r).toMatchObject({ eligible_count: 6, sent_count: 6, failed_count: 0, suppressed_count: 0, already_done_count: 0, in_doubt_count: 0 });
      // One recipient per email, each an eligible account holder's own address, once.
      expect(mailer.sent.map((s) => s.to).sort()).toEqual(ELIGIBLE.map((l) => users[l]!.email).sort());
      expect(mailer.sent.every((s) => s.subject === 'We are updating the Aramo Privacy Notice')).toBe(true);
      // Rate limited: a 500 ms gap before every send but the first (2 per second).
      expect(sleeps).toEqual([500, 500, 500, 500, 500]);

      const rows = await deliveries('1.1');
      expect(rows).toHaveLength(6);
      const sha = templateSha256('aramo.privacy_notice', '1.1', LEGAL_CHANGE_NOTICE_TEMPLATE, SUMMARIES);
      for (const row of rows) {
        const u = Object.values(users).find((x) => x.id === row.user_id)!;
        // Tenant isolation: each row carries the recipient's own tenant.
        expect(row.tenant_id).toBe(u.tenant);
        expect(row).toMatchObject({
          channel: 'EMAIL',
          status: 'SENT',
          provider: 'stub',
          error_code: null,
          attempt_count: 1,
          template_id: 'aramo.legal_change_notice',
          template_version: '0.1.0',
          template_sha256: sha,
          run_id: r.run_id,
          effective_date: EFFECTIVE,
        });
        expect(row.provider_message_id).toMatch(/^msg-/);
        expect(row.sent_at).not.toBeNull();
      }
      expect(await run(r.run_id)).toMatchObject({ mode: 'SEND', status: 'COMPLETED', sent_count: 6, authorization_ref: 'TEST-AUTH-1', template_sha256: sha });
      // No address or body is stored anywhere in the evidence.
      const dump = JSON.stringify((await db.query(`SELECT * FROM subscription."LegalChangeNoticeDelivery"`)).rows);
      for (const u of Object.values(users)) expect(dump).not.toContain(u.email);
    });

    it('running it again sends nothing (idempotent per document, version and user)', async () => {
      const mailer = new CapturingMailer();
      const r = await service(mailer).run(opts('1.1'));
      expect(r).toMatchObject({ eligible_count: 6, sent_count: 0, already_done_count: 6 });
      expect(mailer.sent).toEqual([]);
      expect((await deliveries('1.1')).every((d) => d.attempt_count === 1)).toBe(true);
      const dry = await service(mailer).run(opts('1.1', { mode: 'DRY_RUN', approved_template: null, authorization_ref: null }));
      expect(dry.would_send_count).toBe(0);
    });
  });

  describe('partial failure and resume', () => {
    it('records the failures, and a re-run retries only those', async () => {
      const failing = new CapturingMailer(new Set([users['b1-member']!.email, users['personal']!.email]));
      const first = await service(failing).run(opts('1.2'));
      expect(first).toMatchObject({ sent_count: 4, failed_count: 2 });
      const failed = (await deliveries('1.2')).filter((d) => d.status === 'FAILED');
      expect(failed.map((d) => d.user_id).sort()).toEqual([users['b1-member']!.id, users['personal']!.id].sort());
      expect(failed.every((d) => d.error_code === 'MessageRejected' && d.provider_message_id === null)).toBe(true);

      const healthy = new CapturingMailer();
      const second = await service(healthy).run(opts('1.2'));
      expect(second).toMatchObject({ sent_count: 2, failed_count: 0, already_done_count: 4 });
      expect(healthy.sent.map((s) => s.to).sort()).toEqual([users['b1-member']!.email, users['personal']!.email].sort());
      const rows = await deliveries('1.2');
      expect(rows.every((d) => d.status === 'SENT')).toBe(true);
      expect(rows.filter((d) => d.attempt_count === 2).map((d) => d.user_id).sort()).toEqual([users['b1-member']!.id, users['personal']!.id].sort());
      expect(rows.filter((d) => d.attempt_count === 2).every((d) => d.run_id === second.run_id)).toBe(true);
    });

    it('an interrupted run leaves its recipient in doubt: skipped on resume unless --resend-in-doubt', async () => {
      // The evidence store dies right after the provider accepted the 2nd email.
      let marks = 0;
      const flaky = Object.create(repo) as LegalChangeNoticeRepository;
      flaky.markSent = async (...a: Parameters<LegalChangeNoticeRepository['markSent']>) => {
        marks++;
        if (marks === 2) throw new Error('connection lost');
        return repo.markSent(...a);
      };
      const m1 = new CapturingMailer();
      await expect(service(m1, { repository: flaky }).run(opts('1.3'))).rejects.toThrow('connection lost');
      expect(m1.sent).toHaveLength(2);
      const aborted = (await db.query(`SELECT * FROM subscription."LegalChangeNoticeRun" WHERE version = '1.3' AND mode = 'SEND'`)).rows;
      expect(aborted).toHaveLength(1);
      expect(aborted[0]).toMatchObject({ status: 'ABORTED', sent_count: 1 });
      const pending = (await deliveries('1.3')).filter((d) => d.status === 'PENDING');
      expect(pending).toHaveLength(1);
      const doubtful = pending[0]!.user_id;

      const m2 = new CapturingMailer();
      const resumed = await service(m2).run(opts('1.3'));
      expect(resumed).toMatchObject({ sent_count: 4, already_done_count: 1, in_doubt_count: 1 });
      expect(m2.sent.map((s) => s.to)).not.toContain(Object.values(users).find((u) => u.id === doubtful)!.email);

      const m3 = new CapturingMailer();
      const forced = await service(m3).run(opts('1.3', { resend_in_doubt: true }));
      expect(forced).toMatchObject({ sent_count: 1, already_done_count: 5, in_doubt_count: 0 });
      expect(m3.sent.map((s) => s.to)).toEqual([Object.values(users).find((u) => u.id === doubtful)!.email]);
      expect((await deliveries('1.3')).every((d) => d.status === 'SENT')).toBe(true);
    });

    it('an address that is not deliverable is SUPPRESSED, not sent and not retried', async () => {
      const m = new CapturingMailer();
      const r = await service(m, {
        holders: { activeAccountHolders: async (a) => (a.after_user_id === null ? [{ user_id: users['b1-owner']!.id, tenant_id: users['b1-owner']!.tenant, email: 'not-an-address', tenant_kind: 'BUSINESS' }] : []) },
      }).run(opts('1.4'));
      expect(r).toMatchObject({ suppressed_count: 1, sent_count: 0 });
      expect(m.sent).toEqual([]);
      expect((await deliveries('1.4'))[0]).toMatchObject({ status: 'SUPPRESSED', error_code: 'invalid_address' });
      const again = await service(m).run(opts('1.4'));
      expect(again.already_done_count).toBe(1);
    });
  });

  describe('evidence integrity and in-service channel', () => {
    it('the evidence trigger refuses deleting a row and changing a delivered one', async () => {
      const row = (await deliveries('1.1'))[0]!;
      await expect(db.query(`DELETE FROM subscription."LegalChangeNoticeDelivery" WHERE document_key = 'aramo.privacy_notice' AND version = '1.1' AND user_id = $1`, [row.user_id])).rejects.toThrow(/cannot be deleted/);
      await expect(
        db.query(`UPDATE subscription."LegalChangeNoticeDelivery" SET status = 'FAILED', sent_at = NULL WHERE document_key = 'aramo.privacy_notice' AND version = '1.1' AND user_id = $1`, [row.user_id]),
      ).rejects.toThrow(/terminal/);
      await expect(
        db.query(`UPDATE subscription."LegalChangeNoticeDelivery" SET tenant_id = $2 WHERE document_key = 'aramo.privacy_notice' AND version = '1.1' AND user_id = $1`, [row.user_id, randomUUID()]),
      ).rejects.toThrow(/immutable/);
    });

    it('in-service records are per user: one user dismissing never affects another tenant’s user', async () => {
      const a = users['b1-owner']!;
      const b = users['personal']!;
      const n = { document_key: 'aramo.privacy_notice', version: '1.5', effective_date: EFFECTIVE };
      await repo.recordInService({ ...n, user_id: a.id, tenant_id: a.tenant, event: 'SHOWN' }, NOW);
      await repo.recordInService({ ...n, user_id: a.id, tenant_id: a.tenant, event: 'SHOWN' }, NOW);
      await repo.recordInService({ ...n, user_id: a.id, tenant_id: a.tenant, event: 'ACKNOWLEDGED' }, NOW);
      await repo.recordInService({ ...n, user_id: b.id, tenant_id: b.tenant, event: 'SHOWN' }, NOW);
      expect(await repo.acknowledgedInService(a.id, [n])).toEqual(new Set(['aramo.privacy_notice@1.5']));
      expect(await repo.acknowledgedInService(b.id, [n])).toEqual(new Set());
      const rows = await deliveries('1.5');
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.channel === 'IN_SERVICE' && r.status === 'SENT' && r.provider_message_id === null)).toBe(true);
      expect(rows.find((r) => r.user_id === a.id)!.tenant_id).toBe(a.tenant);
      // The in-service channel does not count as the email: an email run still sends to both.
      const m = new CapturingMailer();
      const r = await service(m).run(opts('1.5'));
      expect(r.sent_count).toBe(6);
    });
  });

  describe('the operator command wiring', () => {
    it('a dry-run context binds no mailer; a send context binds MAILER_PORT', async () => {
      const saved = { db: process.env['DATABASE_URL'], mp: process.env['MAILER_PROVIDER'] };
      process.env['DATABASE_URL'] = url;
      process.env['MAILER_PROVIDER'] = 'stub';
      try {
        const dry = await NestFactory.createApplicationContext(LegalChangeNoticeCliModule.forMode('DRY_RUN'), { logger: false });
        expect(dry.get(IdentityRepository)).toBeInstanceOf(IdentityRepository);
        expect(dry.get(LegalChangeNoticeRepository)).toBeInstanceOf(LegalChangeNoticeRepository);
        expect(() => dry.get(MAILER_PORT)).toThrow();
        const count = (await dry.get(IdentityRepository).listActiveAccountHolders({ after_user_id: null, limit: 100, audience: 'ALL' })).length;
        expect(count).toBe(6);
        await dry.close();
        const send = await NestFactory.createApplicationContext(LegalChangeNoticeCliModule.forMode('SEND'), { logger: false });
        expect(typeof send.get<LegalNoticeMailer>(MAILER_PORT).send).toBe('function');
        await send.close();
      } finally {
        process.env['DATABASE_URL'] = saved.db;
        process.env['MAILER_PROVIDER'] = saved.mp;
        if (saved.db === undefined) delete process.env['DATABASE_URL'];
        if (saved.mp === undefined) delete process.env['MAILER_PROVIDER'];
      }
    });
  });
});
