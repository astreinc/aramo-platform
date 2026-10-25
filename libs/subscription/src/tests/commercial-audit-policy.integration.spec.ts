import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CommercialAuditCursorError, CommercialAuditRepository } from '../lib/commercial/commercial-audit.repository.js';
import { CommercialPolicyUnavailableError, commercialPolicyChecksum } from '../lib/commercial/commercial-policy.js';
import { CommercialPolicyRepository } from '../lib/commercial/commercial-policy.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { CCP_A2_MIGRATION, seededPolicyV1 } from './fixtures/commercial-policy-seed.js';

// CCP-A2 (PBD §5.1 row A2, mandatory tests) on real Postgres 17, with the A2 migration
// applied on top of the FULL subscription chain (plus the metering init it depends on):
//   - UPDATE and DELETE on CommercialAuditEvent and CommercialPolicyAuditEvent raise;
//   - CommercialPolicyVersion: DELETE raises in every state; content is immutable once the
//     row leaves DRAFT; only DRAFT→ACTIVE, ACTIVE→RETIRED, RETIRED→ACTIVE moves;
//   - exactly one ACTIVE (seed) and at most one ACTIVE (partial unique index);
//   - version numbers are taken under the advisory lock (concurrent drafts serialize);
//   - a missing, malformed or tampered ACTIVE policy fails closed;
//   - the seed is idempotent; the audit read filters and pages correctly.

const MIGRATIONS = [
  '../../../metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20261018120000_init_subscription_allowance/migration.sql',
  '../../prisma/migrations/20261019100000_subscription_lifecycle_billing/migration.sql',
  '../../prisma/migrations/20261019140000_sign_commercial_catalog_a1/migration.sql',
  '../../prisma/migrations/20261020130300_sign_naming_keys/migration.sql',
  '../../prisma/migrations/20261022100100_billing_account_country_guard/migration.sql',
  '../../prisma/migrations/20261022110100_billing_flag_domain_reason/migration.sql',
  '../../prisma/migrations/20261023100000_sign_personal_free/migration.sql',
  '../../prisma/migrations/20261023120000_legal_acceptance_in_app/migration.sql',
].map((p) => resolve(__dirname, p));

const V1 = '019a0000-0000-7000-8000-0000000cc201';
const SEED_AUDIT = '019a0000-0000-7000-8000-0000000cc203';
const SEED_POLICY_AUDIT = '019a0000-0000-7000-8000-0000000cc202';
const USER_A = '0190cccc-0000-7000-8000-00000000000a';
const USER_B = '0190cccc-0000-7000-8000-00000000000b';
const TENANT_1 = '0190dddd-0000-7000-8000-000000000001';
const TENANT_2 = '0190dddd-0000-7000-8000-000000000002';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A2 commercial audit + CommercialPolicyVersion (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let url: string;
  let pg: Client;
  let prisma: PrismaService;
  let policies: CommercialPolicyRepository;
  let audit: CommercialAuditRepository;

  async function reset(): Promise<void> {
    await pg.query('DROP SCHEMA IF EXISTS subscription CASCADE');
    await pg.query('DROP SCHEMA IF EXISTS metering CASCADE');
    for (const m of MIGRATIONS) await pg.query(readFileSync(m, 'utf8'));
    await pg.query(readFileSync(CCP_A2_MIGRATION, 'utf8'));
  }

  async function raises(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await pg.query(sql, params);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error(`expected the statement to raise: ${sql}`);
  }

  async function draft(content: object, checksum = commercialPolicyChecksum(content), id = crypto.randomUUID(), n = 2): Promise<string> {
    await pg.query(
      `INSERT INTO subscription."CommercialPolicyVersion" (id, version_number, status, content, content_checksum) VALUES ($1, $2, 'DRAFT', $3::jsonb, $4)`,
      [id, n, JSON.stringify(content), checksum],
    );
    return id;
  }

  async function swapActive(toId: string): Promise<void> {
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'RETIRED', retired_at = now() WHERE status = 'ACTIVE'`);
    await pg.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'ACTIVE', activated_at = now() WHERE id = $1`, [toId]);
    await pg.query('COMMIT');
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    prisma = new PrismaService(url);
    await prisma.$connect();
    policies = new CommercialPolicyRepository(prisma);
    audit = new CommercialAuditRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  beforeEach(async () => {
    await reset();
  }, 60_000);

  // ---- seed ------------------------------------------------------------------------

  it('seeds exactly one ACTIVE v1 whose content and checksum equal the migration literal; the fail-closed read parses it', async () => {
    const rows = (await pg.query(`SELECT id, version_number, status, content, content_checksum FROM subscription."CommercialPolicyVersion"`)).rows;
    expect(rows).toHaveLength(1);
    const { content, checksum } = seededPolicyV1();
    expect(rows[0]).toEqual({ id: V1, version_number: 1, status: 'ACTIVE', content, content_checksum: checksum });
    const active = await policies.getActivePolicy();
    expect(active.version_id).toBe(V1);
    expect(active.checksum).toBe(commercialPolicyChecksum(content));
    expect(active.content).toEqual(content);
    const seedAudit = (await pg.query(`SELECT id, event_type, policy_version_id, subject, actor_type FROM subscription."CommercialAuditEvent"`)).rows;
    expect(seedAudit).toEqual([{ id: SEED_AUDIT, event_type: 'COMMERCIAL_POLICY_VERSION_ACTIVATED', policy_version_id: V1, subject: `commercial_policy_version:${V1}`, actor_type: 'system' }]);
    const policyAudit = (await pg.query(`SELECT id, event_type, subject_id FROM subscription."CommercialPolicyAuditEvent"`)).rows;
    expect(policyAudit).toEqual([{ id: SEED_POLICY_AUDIT, event_type: 'COMMERCIAL_POLICY_VERSION_ACTIVATED', subject_id: V1 }]);
  });

  it('the seed block is idempotent: re-running it inserts nothing', async () => {
    const sql = readFileSync(CCP_A2_MIGRATION, 'utf8');
    await pg.query(sql.slice(sql.indexOf('-- commercial-policy-v1-content')));
    for (const t of ['CommercialPolicyVersion', 'CommercialPolicyAuditEvent', 'CommercialAuditEvent']) {
      expect((await pg.query(`SELECT count(*)::int n FROM subscription."${t}"`)).rows[0].n, t).toBe(1);
    }
  });

  // ---- append-only audit streams -----------------------------------------------------

  it('CommercialAuditEvent: UPDATE raises', async () => {
    const msg = await raises(`UPDATE subscription."CommercialAuditEvent" SET event_type = 'X_CHANGED' WHERE id = $1`, [SEED_AUDIT]);
    expect(msg).toBe('CommercialAuditEvent is an append-only commercial audit ledger (UPDATE rejected)');
  });
  it('CommercialAuditEvent: DELETE raises', async () => {
    const msg = await raises(`DELETE FROM subscription."CommercialAuditEvent" WHERE id = $1`, [SEED_AUDIT]);
    expect(msg).toBe('CommercialAuditEvent is an append-only commercial audit ledger (DELETE rejected)');
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialAuditEvent"`)).rows[0].n).toBe(1);
  });
  it('CommercialAuditEvent: UPDATE of the payload alone raises (unconditional)', async () => {
    const msg = await raises(`UPDATE subscription."CommercialAuditEvent" SET payload = payload WHERE id = $1`, [SEED_AUDIT]);
    expect(msg).toMatch(/append-only commercial audit ledger \(UPDATE rejected\)/);
  });
  it('CommercialPolicyAuditEvent: UPDATE raises', async () => {
    const msg = await raises(`UPDATE subscription."CommercialPolicyAuditEvent" SET event_type = 'COMMERCIAL_POLICY_VERSION_RETIRED' WHERE id = $1`, [SEED_POLICY_AUDIT]);
    expect(msg).toBe('CommercialPolicyAuditEvent is an append-only governance ledger (UPDATE rejected)');
  });
  it('CommercialPolicyAuditEvent: DELETE raises', async () => {
    const msg = await raises(`DELETE FROM subscription."CommercialPolicyAuditEvent" WHERE id = $1`, [SEED_POLICY_AUDIT]);
    expect(msg).toBe('CommercialPolicyAuditEvent is an append-only governance ledger (DELETE rejected)');
  });

  // ---- policy version immutability -----------------------------------------------------

  it('CommercialPolicyVersion: DELETE raises for ACTIVE, DRAFT and RETIRED rows', async () => {
    expect(await raises(`DELETE FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [V1])).toBe('CommercialPolicyVersion is append-only (DELETE rejected)');
    const d = await draft({ ...(seededPolicyV1().content as object), approval_expiry_hours: 48 });
    expect(await raises(`DELETE FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [d])).toBe('CommercialPolicyVersion is append-only (DELETE rejected)');
    await swapActive(d);
    expect(await raises(`DELETE FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [V1])).toBe('CommercialPolicyVersion is append-only (DELETE rejected)');
  });

  it('CommercialPolicyVersion: ACTIVE content, checksum and note are immutable', async () => {
    const expected = 'CommercialPolicyVersion content is immutable once it leaves DRAFT (create a new version instead)';
    expect(await raises(`UPDATE subscription."CommercialPolicyVersion" SET content = jsonb_set(content, '{approval_expiry_hours}', '96') WHERE id = $1`, [V1])).toBe(expected);
    expect(await raises(`UPDATE subscription."CommercialPolicyVersion" SET content_checksum = repeat('0', 64) WHERE id = $1`, [V1])).toBe(expected);
    expect(await raises(`UPDATE subscription."CommercialPolicyVersion" SET note = 'edited' WHERE id = $1`, [V1])).toBe(expected);
    expect(await raises(`UPDATE subscription."CommercialPolicyVersion" SET version_number = 9 WHERE id = $1`, [V1])).toBe('CommercialPolicyVersion identity is immutable');
  });

  it('CommercialPolicyVersion: RETIRED content is immutable; DRAFT content is editable; activating with a content change raises', async () => {
    const base = seededPolicyV1().content as Record<string, unknown>;
    const d = await draft({ ...base, approval_expiry_hours: 48 });
    // DRAFT edit allowed.
    const edited = { ...base, approval_expiry_hours: 24 };
    await pg.query(`UPDATE subscription."CommercialPolicyVersion" SET content = $2::jsonb, content_checksum = $3 WHERE id = $1`, [d, JSON.stringify(edited), commercialPolicyChecksum(edited)]);
    // DRAFT → ACTIVE together with a content change: refused.
    expect(await raises(`UPDATE subscription."CommercialPolicyVersion" SET status = 'ACTIVE', activated_at = now(), content = $2::jsonb WHERE id = $1`, [d, JSON.stringify(base)])).toMatch(/content is immutable once it leaves DRAFT/);
    await swapActive(d);
    // v1 is now RETIRED: immutable.
    expect(await raises(`UPDATE subscription."CommercialPolicyVersion" SET note = 'x' WHERE id = $1`, [V1])).toMatch(/content is immutable once it leaves DRAFT/);
  });

  it('CommercialPolicyVersion: only DRAFT→ACTIVE, ACTIVE→RETIRED, RETIRED→ACTIVE are allowed', async () => {
    expect(await raises(`UPDATE subscription."CommercialPolicyVersion" SET status = 'DRAFT' WHERE id = $1`, [V1])).toBe('CommercialPolicyVersion status ACTIVE -> DRAFT is not allowed');
    const d = await draft({ ...(seededPolicyV1().content as object), approval_expiry_hours: 48 });
    expect(await raises(`UPDATE subscription."CommercialPolicyVersion" SET status = 'RETIRED' WHERE id = $1`, [d])).toBe('CommercialPolicyVersion status DRAFT -> RETIRED is not allowed');
    await swapActive(d); // ACTIVE→RETIRED (v1) + DRAFT→ACTIVE (d)
    expect(await raises(`UPDATE subscription."CommercialPolicyVersion" SET status = 'DRAFT' WHERE id = $1`, [V1])).toBe('CommercialPolicyVersion status RETIRED -> DRAFT is not allowed');
    await swapActive(V1); // RETIRED→ACTIVE: the rollback path (A3 makes it a change request)
    expect((await policies.getActivePolicy()).version_id).toBe(V1);
  });

  // ---- one ACTIVE ------------------------------------------------------------------------

  it('at most one ACTIVE: a second ACTIVE row is refused by the partial unique index (insert and update)', async () => {
    const content = { ...(seededPolicyV1().content as object), approval_expiry_hours: 48 };
    const insertMsg = await raises(
      `INSERT INTO subscription."CommercialPolicyVersion" (id, version_number, status, content, content_checksum, activated_at) VALUES (gen_random_uuid(), 2, 'ACTIVE', $1::jsonb, $2, now())`,
      [JSON.stringify(content), commercialPolicyChecksum(content)],
    );
    expect(insertMsg).toMatch(/CommercialPolicyVersion_one_active_key/);
    const d = await draft(content);
    expect(await raises(`UPDATE subscription."CommercialPolicyVersion" SET status = 'ACTIVE', activated_at = now() WHERE id = $1`, [d])).toMatch(/CommercialPolicyVersion_one_active_key/);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialPolicyVersion" WHERE status = 'ACTIVE'`)).rows[0].n).toBe(1);
  });

  it('an ACTIVE row must carry activated_at; a checksum must be 64 hex chars; content must be an object', async () => {
    expect(await raises(`INSERT INTO subscription."CommercialPolicyVersion" (id, version_number, status, content, content_checksum) VALUES (gen_random_uuid(), 3, 'DRAFT', '{}'::jsonb, 'abc')`)).toMatch(/content_checksum_check/);
    expect(await raises(`INSERT INTO subscription."CommercialPolicyVersion" (id, version_number, status, content, content_checksum) VALUES (gen_random_uuid(), 3, 'DRAFT', '[]'::jsonb, repeat('a', 64))`)).toMatch(/content_check/);
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'RETIRED' WHERE id = $1`, [V1]);
    const msg = await raises(`INSERT INTO subscription."CommercialPolicyVersion" (id, version_number, status, content, content_checksum) VALUES (gen_random_uuid(), 3, 'ACTIVE', '{}'::jsonb, repeat('a', 64))`);
    await pg.query('ROLLBACK');
    expect(msg).toMatch(/active_activated_check/);
  });

  // ---- version numbering under the advisory lock -----------------------------------------

  it('createDraftVersion: concurrent drafts take distinct consecutive numbers under the advisory lock, each with a CREATED audit row; ACTIVE unchanged', async () => {
    const base = seededPolicyV1().content as Record<string, unknown>;
    const made = await Promise.all(
      [48, 24, 12, 6, 96].map((h) => policies.createDraftVersion({ content: { ...base, approval_expiry_hours: h } as never, actor: { id: USER_A, type: 'user' } })),
    );
    expect(made.map((r) => r.version_number).sort()).toEqual([2, 3, 4, 5, 6]);
    for (const r of made) {
      expect(r.status).toBe('DRAFT');
      expect(r.content_checksum).toBe(commercialPolicyChecksum(r.content));
    }
    const created = (await pg.query(`SELECT count(*)::int n FROM subscription."CommercialPolicyAuditEvent" WHERE event_type = 'COMMERCIAL_POLICY_VERSION_CREATED' AND actor_id = $1`, [USER_A])).rows[0].n;
    expect(created).toBe(5);
    expect((await policies.getActivePolicy()).version_id).toBe(V1);
  });

  it('createDraftVersion refuses malformed content before writing (no row, no audit)', async () => {
    await expect(policies.createDraftVersion({ content: { approval_expiry_hours: 72 } as never })).rejects.toBeInstanceOf(CommercialPolicyUnavailableError);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialPolicyVersion"`)).rows[0].n).toBe(1);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialPolicyAuditEvent"`)).rows[0].n).toBe(1);
  });

  // ---- fail closed ------------------------------------------------------------------------

  async function reasonOfActive(): Promise<string> {
    try {
      await policies.getActivePolicy();
    } catch (e) {
      if (e instanceof CommercialPolicyUnavailableError) return e.reason;
      throw e;
    }
    return 'OK';
  }

  it('fail closed: no ACTIVE version → MISSING', async () => {
    await pg.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'RETIRED', retired_at = now() WHERE id = $1`, [V1]);
    expect(await reasonOfActive()).toBe('MISSING');
  });

  it('fail closed: a malformed ACTIVE document → MALFORMED', async () => {
    const bad = { ...(seededPolicyV1().content as object), discount_escalation_threshold_bps: '20%' };
    await swapActive(await draft(bad));
    expect(await reasonOfActive()).toBe('MALFORMED');
  });

  it('fail closed: an ACTIVE document whose stored checksum does not match → CHECKSUM_MISMATCH', async () => {
    const content = { ...(seededPolicyV1().content as object), approval_expiry_hours: 48 };
    await swapActive(await draft(content, 'f'.repeat(64)));
    expect(await reasonOfActive()).toBe('CHECKSUM_MISMATCH');
  });

  // ---- audit append + read ----------------------------------------------------------------

  it('append: FK to the policy version, closed actor types, a user actor needs actor_id, subject and event_type formats', async () => {
    await expect(
      audit.append({ actor: { id: USER_A, type: 'user', role_keys: [] }, event_type: 'X_EVENT', subject: 'tenant:1', policy_version_id: '0190eeee-0000-7000-8000-000000000000', correlation_id: 'c' }),
    ).rejects.toThrow(/CommercialAuditEvent_policy_version_id_fkey|Foreign key/i);
    await expect(audit.append({ actor: { id: null, type: 'user', role_keys: [] }, event_type: 'X_EVENT', subject: 'tenant:1', policy_version_id: V1, correlation_id: 'c' })).rejects.toThrow(/user actor/);
    await expect(audit.append({ actor: { id: USER_A, type: 'user', role_keys: [] }, event_type: 'lower', subject: 'tenant:1', policy_version_id: V1, correlation_id: 'c' })).rejects.toThrow(/event_type/);
    await expect(audit.append({ actor: { id: USER_A, type: 'user', role_keys: [] }, event_type: 'X_EVENT', subject: 'no-kind', policy_version_id: V1, correlation_id: 'c' })).rejects.toThrow(/subject/);
    expect(await raises(`INSERT INTO subscription."CommercialAuditEvent" (id, actor_type, event_type, subject, policy_version_id, correlation_id) VALUES (gen_random_uuid(), 'robot', 'X_EVENT', 'tenant:1', $1, 'c')`, [V1])).toMatch(/actor_type_check/);
    expect(await raises(`INSERT INTO subscription."CommercialAuditEvent" (id, actor_type, event_type, subject, policy_version_id, correlation_id) VALUES (gen_random_uuid(), 'user', 'X_EVENT', 'tenant:1', $1, 'c')`, [V1])).toMatch(/user_actor_check/);
  });

  it('append inside a rolled-back transaction leaves no row (the event commits with its change)', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await audit.append({ actor: { id: USER_A, type: 'user', role_keys: ['finance_admin'] }, event_type: 'X_EVENT', subject: 'tenant:1', policy_version_id: V1, correlation_id: 'c' }, tx);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialAuditEvent"`)).rows[0].n).toBe(1);
  });

  it('list: filters (actor, event_type, tenant, date range, exception-only) AND together; newest first; role keys snapshot sorted', async () => {
    const t0 = Date.now();
    const mk = async (actor: string, event_type: string, tenant: string | null, is_exception: boolean, offsetMs: number) => {
      const r = await audit.append({ actor: { id: actor, type: 'user', role_keys: ['platform_owner', 'finance_admin'] }, event_type, tenant_id: tenant, is_exception, subject: `tenant:${tenant ?? 'none'}`, policy_version_id: V1, payload: { n: offsetMs }, correlation_id: `req-${offsetMs}` });
      await pg.query(`ALTER TABLE subscription."CommercialAuditEvent" DISABLE TRIGGER commercial_audit_event_no_update`);
      await pg.query(`UPDATE subscription."CommercialAuditEvent" SET created_at = to_timestamp($2 / 1000.0) WHERE id = $1`, [r.id, t0 + offsetMs]);
      await pg.query(`ALTER TABLE subscription."CommercialAuditEvent" ENABLE TRIGGER commercial_audit_event_no_update`);
      return r.id;
    };
    // Fixture timestamps are set with the trigger disabled by the test superuser only.
    const a1 = await mk(USER_A, 'SUPPORT_EXTENSION_EXCEPTION_APPLIED', TENANT_1, true, 1000);
    const a2 = await mk(USER_A, 'X_EVENT', TENANT_2, false, 2000);
    const b1 = await mk(USER_B, 'SUPPORT_EXTENSION_EXCEPTION_APPLIED', TENANT_1, true, 3000);
    const b2 = await mk(USER_B, 'X_EVENT', TENANT_1, false, 4000);

    const ids = async (q: Parameters<CommercialAuditRepository['list']>[0]) => (await audit.list(q)).events.map((e) => e.id);
    expect((await ids({})).slice(0, 4)).toEqual([b2, b1, a2, a1]);
    expect(await ids({ actor_id: USER_A })).toEqual([a2, a1]);
    expect(await ids({ event_type: 'SUPPORT_EXTENSION_EXCEPTION_APPLIED' })).toEqual([b1, a1]);
    expect(await ids({ tenant_id: TENANT_1 })).toEqual([b2, b1, a1]);
    expect(await ids({ exception_only: true })).toEqual([b1, a1]);
    expect(await ids({ from: new Date(t0 + 2000), to: new Date(t0 + 4000) })).toEqual([b1, a2]); // from inclusive, to exclusive
    expect(await ids({ actor_id: USER_B, tenant_id: TENANT_1, exception_only: true })).toEqual([b1]);
    const row = (await audit.list({ actor_id: USER_A })).events[0];
    expect(row?.actor_role_keys).toEqual(['finance_admin', 'platform_owner']);
    expect(row?.payload).toEqual({ n: 2000 });
  });

  it('list: keyset paging visits every row exactly once, including rows that share created_at; the cursor is pinned to its filters', async () => {
    const at = new Date('2026-10-24T10:00:00.123Z');
    const made: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const r = await audit.append({ actor: { id: USER_A, type: 'user', role_keys: [] }, event_type: 'X_EVENT', tenant_id: TENANT_1, subject: `tenant:${TENANT_1}`, policy_version_id: V1, correlation_id: `p${i}` });
      made.push(r.id);
    }
    // Same millisecond for 4 of them (tie broken by id DESC).
    await pg.query(`ALTER TABLE subscription."CommercialAuditEvent" DISABLE TRIGGER commercial_audit_event_no_update`);
    await pg.query(`UPDATE subscription."CommercialAuditEvent" SET created_at = $2 WHERE id = ANY($1::uuid[])`, [made.slice(0, 4), at]);
    await pg.query(`ALTER TABLE subscription."CommercialAuditEvent" ENABLE TRIGGER commercial_audit_event_no_update`);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await audit.list({ tenant_id: TENANT_1, limit: 3, cursor });
      seen.push(...page.events.map((e) => e.id));
      cursor = page.next_cursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort()).toEqual([...made].sort());

    const first = await audit.list({ tenant_id: TENANT_1, limit: 3 });
    await expect(audit.list({ tenant_id: TENANT_2, limit: 3, cursor: first.next_cursor ?? '' })).rejects.toBeInstanceOf(CommercialAuditCursorError);
    await expect(audit.list({ cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(CommercialAuditCursorError);
  });
});
