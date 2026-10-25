import { createHash } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CommercialAuditExportService, CommercialAuditExportTooLargeError } from '../lib/commercial/commercial-audit-export.service.js';
import { CommercialAuditRepository } from '../lib/commercial/commercial-audit.repository.js';
import {
  CommercialApprovalRefusedError,
  type CommercialActor,
  CommercialChangeRequestError,
  CommercialChangeRequestService,
  CommercialNotBootstrappedError,
} from '../lib/commercial/commercial-change-request.service.js';
import { CommercialOperatorRepository } from '../lib/commercial/commercial-operator.repository.js';
import { CommercialOperatorRosterService } from '../lib/commercial/commercial-operator-roster.service.js';
import { CommercialPolicyGovernanceService } from '../lib/commercial/commercial-policy-governance.service.js';
import { CommercialPolicyRepository } from '../lib/commercial/commercial-policy.repository.js';
import { commercialPolicyChecksum } from '../lib/commercial/commercial-policy.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { CCP_BUNDLES, PLATFORM_TENANT, POLICY_V1, TENANT_1, addOperator, grantRole, revokeRole } from './support/ccp-a3-database.js';
import { applyCcpA9Schema } from './support/ccp-a9-database.js';

// CCP-B5 (PBD §5.3 row B5; TD-A9-16; TD-A3-0 NC-5 ratified) on real Postgres 17: the identity
// chain (A9 last-owner trigger included), the subscription chain, A2, A3 and the A9
// subscription migration — the guard is the A9 one, UNCHANGED by B5. Test IDs are cited by
// doc/ccp/slices/CCP-B5-acceptance.md.

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-B5 policy activation apply (NC-5), policy drafts, audit export, roster (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let svc: CommercialChangeRequestService;
  let gov: CommercialPolicyGovernanceService;
  let exporter: CommercialAuditExportService;
  let roster: CommercialOperatorRosterService;
  let policies: CommercialPolicyRepository;
  const ctx = { platform_tenant_id: PLATFORM_TENANT, correlation_id: 'ccp-b5-spec' };
  let keyN = 0;
  const key = () => `b5-key-${String(++keyN).padStart(6, '0')}`;
  const as = (user_id: string, roles: readonly string[]): CommercialActor => ({ user_id, actor_kind: 'user', scopes: [...new Set(roles.flatMap((r) => CCP_BUNDLES[r] ?? []))] });

  async function outcome(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      if (e instanceof CommercialApprovalRefusedError) return e.refusal;
      if (e instanceof CommercialNotBootstrappedError) return 'CCP_NOT_BOOTSTRAPPED';
      if (e instanceof CommercialChangeRequestError) return `${e.code}${typeof e.details['reason'] === 'string' ? `:${e.details['reason']}` : ''}`;
      if (e instanceof CommercialAuditExportTooLargeError) return 'EXPORT_TOO_LARGE';
      throw e;
    }
    return 'OK';
  }
  const versions = async () => (await pg.query(`SELECT id, version_number, status FROM subscription."CommercialPolicyVersion" ORDER BY version_number`)).rows as Array<{ id: string; version_number: number; status: string }>;
  const statusOf = async (id: string) => (await pg.query(`SELECT status FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [id])).rows[0]?.status as string;
  const eventsOf = async (id: string): Promise<string[]> =>
    (await pg.query(`SELECT event_type FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [id])).rows.map((r) => r.event_type as string);
  const rowJson = async (sql: string, params: unknown[]) => JSON.stringify((await pg.query(sql, params)).rows);
  const snapshotOf = async (id: string) => ({
    request: await rowJson(`SELECT row_to_json(r)::text AS j FROM subscription."CommercialChangeRequest" r WHERE id = $1`, [id]),
    approvals: await rowJson(`SELECT row_to_json(a)::text AS j FROM subscription."CommercialApproval" a WHERE change_request_id = $1 ORDER BY step_index`, [id]),
  });
  const count = async (sql: string, params: unknown[] = []) => Number((await pg.query(sql, params)).rows[0].n);

  /** The governance cast: two attested finance_admins and one attested platform_owner. */
  async function cast() {
    const FA = await addOperator(pg, ['finance_admin']);
    const FA2 = await addOperator(pg, ['finance_admin']);
    const P = await addOperator(pg, ['platform_owner']);
    return { FA, FA2, P };
  }
  /** A DRAFT v2 from v1 by `author`, optionally edited. */
  async function draft(author: string, roles: readonly string[], content?: Record<string, unknown>): Promise<string> {
    const v = await gov.createDraft(as(author, roles), { source_version_id: POLICY_V1 }, ctx);
    if (content !== undefined) await gov.updateDraft(as(author, roles), v.id, { content }, ctx);
    return v.id;
  }
  async function activationRequest(FA: string, target: string, payload: Record<string, unknown> = {}) {
    const { request } = await svc.create(as(FA, ['finance_admin']), { action_type: 'POLICY_ACTIVATE', payload: { policy_version_id: target, ...payload }, reason: 'activate', idempotency_key: key() }, ctx);
    await svc.submit(as(FA, ['finance_admin']), request.id, ctx);
    return request.id;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    prisma = new PrismaService(url);
    await prisma.$connect();
    const audit = new CommercialAuditRepository(prisma);
    policies = new CommercialPolicyRepository(prisma);
    const operators = new CommercialOperatorRepository(prisma, audit, policies);
    svc = new CommercialChangeRequestService(prisma, audit, policies, operators);
    gov = new CommercialPolicyGovernanceService(prisma, policies, audit, operators);
    exporter = new CommercialAuditExportService(prisma, audit, policies, operators);
    roster = new CommercialOperatorRosterService(prisma, operators, policies);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  beforeEach(async () => {
    await applyCcpA9Schema(pg);
  }, 120_000);

  // ---- the POLICY_ACTIVATE apply ------------------------------------------------------

  it('B5-APPLY-1 an approved activation applies once the finance → owner chain completes: v2 ACTIVE, v1 RETIRED, audited; the request stays APPROVED with effect_applied_at; a re-apply is a no-op; new requests use v2', async () => {
    const { FA, FA2, P } = await cast();
    const V2 = await draft(FA, ['finance_admin'], { credit_escalation_threshold_minor: 30_000, approval_expiry_hours: 48 });
    const id = await activationRequest(FA, V2);
    const stored = (await pg.query(`SELECT payload FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].payload;
    const v2checksum = (await pg.query(`SELECT content_checksum FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [V2])).rows[0].content_checksum as string;
    expect(stored).toEqual({ policy_version_id: V2, target_content_checksum: v2checksum });
    await svc.approve(as(FA2, ['finance_admin']), id, { step_index: 0 }, ctx);
    const done = await svc.approve(as(P, ['platform_owner']), id, { step_index: 1 }, ctx);
    expect(done.apply).toMatchObject({ applied: true, reason: null, detail: { change: 'POLICY_ACTIVATE', from_version_id: POLICY_V1, to_version_id: V2, rollback: false } });
    expect(done.request.state).toBe('APPROVED');
    expect(done.request.effect_applied_at).toBeInstanceOf(Date);
    expect(await versions()).toEqual([
      { id: POLICY_V1, version_number: 1, status: 'RETIRED' },
      { id: V2, version_number: 2, status: 'ACTIVE' },
    ]);
    const v2row = (await pg.query(`SELECT activated_by, activated_at, retired_at FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [V2])).rows[0];
    expect(v2row.activated_by).toBe(P);
    expect(v2row.retired_at).toBeNull();
    expect(await eventsOf(id)).toEqual([
      'COMMERCIAL_CHANGE_REQUEST_CREATED',
      'COMMERCIAL_CHANGE_REQUEST_SUBMITTED',
      'COMMERCIAL_APPROVAL_RECORDED',
      'COMMERCIAL_APPROVAL_RECORDED',
      'COMMERCIAL_CHANGE_REQUEST_APPROVED',
      'COMMERCIAL_POLICY_VERSION_ACTIVATED',
      'COMMERCIAL_CHANGE_REQUEST_APPLIED',
    ]);
    expect((await pg.query(`SELECT event_type, subject_id FROM subscription."CommercialPolicyAuditEvent" WHERE event_payload->>'change_request_id' = $1 ORDER BY event_type`, [id])).rows).toEqual([
      { event_type: 'COMMERCIAL_POLICY_VERSION_ACTIVATED', subject_id: V2 },
      { event_type: 'COMMERCIAL_POLICY_VERSION_RETIRED', subject_id: POLICY_V1 },
    ]);
    const view = await svc.get(as(FA, ['finance_admin']), id, ctx);
    expect(view.request.state).toBe('APPROVED');
    expect(view.request.applied_at).toBeNull();
    expect(view.request.effect_applied_at).toBeInstanceOf(Date);
    // Idempotent: a second apply writes nothing.
    const before = await count(`SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent"`);
    const again = await svc.applyPolicyActivation(as(P, ['platform_owner']), id, ctx);
    expect(again).toMatchObject({ applied: true, detail: { replayed: true } });
    expect(await count(`SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent"`)).toBe(before);
    // The active policy is v2: a $400 credit now escalates (threshold $300), finance → owner.
    expect((await policies.getActivePolicy()).content.credit_escalation_threshold_minor).toBe(30_000);
    const OPS = await addOperator(pg, ['commercial_ops']);
    const { request: credit } = await svc.create(as(OPS, ['commercial_ops']), { action_type: 'CREDIT', tenant_id: TENANT_1, product_key: 'sign', payload: { amount_minor: 40_000, currency: 'USD' }, reason: 'x', idempotency_key: key() }, ctx);
    expect((credit.required_chain as { rule: string }).rule).toBe('FINANCE_THEN_OWNER');
    expect(credit.policy_version_id).toBe(V2);
  });

  it('B5-NC5-a role revocation between approval and apply: the apply is refused (APPROVER_NO_LONGER_ELIGIBLE), fail closed, the signatures are byte-identical, nothing is activated; once eligibility returns the same approvals apply', async () => {
    const { FA, FA2, P } = await cast();
    const V2 = await draft(FA, ['finance_admin'], { approval_expiry_hours: 48 });
    const id = await activationRequest(FA, V2);
    await svc.approve(as(FA2, ['finance_admin']), id, { step_index: 0 }, ctx);
    await revokeRole(pg, FA2, 'finance_admin'); // the finance signer loses the role after signing
    const done = await svc.approve(as(P, ['platform_owner']), id, { step_index: 1 }, ctx);
    expect(done.apply).toMatchObject({ applied: false, reason: 'APPROVER_NO_LONGER_ELIGIBLE', detail: { step_index: 0, approver_user_id: FA2 } });
    expect(done.request.state).toBe('APPROVED');
    const snap = await snapshotOf(id);
    const again = await svc.applyPolicyActivation(as(P, ['platform_owner']), id, ctx);
    expect(again.reason).toBe('APPROVER_NO_LONGER_ELIGIBLE');
    expect(await snapshotOf(id)).toEqual(snap); // the original signatures are never rewritten
    expect(await statusOf(V2)).toBe('DRAFT');
    expect(await statusOf(POLICY_V1)).toBe('ACTIVE');
    expect((await eventsOf(id)).filter((e) => e === 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED')).toHaveLength(2);
    expect((await eventsOf(id)).includes('COMMERCIAL_CHANGE_REQUEST_APPLIED')).toBe(false);
    await grantRole(pg, FA2, 'finance_admin');
    expect((await svc.applyPolicyActivation(as(P, ['platform_owner']), id, ctx)).applied).toBe(true);
    expect(await snapshotOf(id)).toEqual(snap);
    expect(await statusOf(V2)).toBe('ACTIVE');
  });

  it('B5-NC5-b a policy-version change after request creation: revalidation uses the SNAPSHOTTED version (v1 TTL and chain), and the apply is refused POLICY_ACTIVE_CHANGED with nothing written', async () => {
    const { FA, FA2, P } = await cast();
    const V2 = await draft(FA, ['finance_admin'], { approval_expiry_hours: 48 });
    const { request } = await svc.create(as(FA, ['finance_admin']), { action_type: 'POLICY_ACTIVATE', payload: { policy_version_id: V2 }, reason: 'activate', idempotency_key: key() }, ctx);
    // Another version (v3, 24 h TTL) becomes ACTIVE outside this request.
    const v1content = (await pg.query(`SELECT content FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [POLICY_V1])).rows[0].content as Record<string, unknown>;
    const v3content = { ...v1content, approval_expiry_hours: 24 };
    const V3 = '019a0000-0000-7000-8000-0000000cc2b3';
    await pg.query(`INSERT INTO subscription."CommercialPolicyVersion" (id, version_number, status, content, content_checksum) VALUES ($1, 3, 'DRAFT', $2::jsonb, $3)`, [V3, JSON.stringify(v3content), commercialPolicyChecksum(v3content)]);
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'RETIRED', retired_at = now() WHERE status = 'ACTIVE'`);
    await pg.query(`UPDATE subscription."CommercialPolicyVersion" SET status = 'ACTIVE', activated_at = now() WHERE id = $1`, [V3]);
    await pg.query('COMMIT');
    const submitted = await svc.submit(as(FA, ['finance_admin']), request.id, ctx);
    expect((submitted.expires_at as Date).getTime() - (submitted.submitted_at as Date).getTime()).toBe(72 * 3_600_000); // v1, not v3's 24 h
    expect((submitted.required_chain as { rule: string }).rule).toBe('FINANCE_THEN_OWNER');
    await svc.approve(as(FA2, ['finance_admin']), request.id, { step_index: 0 }, ctx);
    const done = await svc.approve(as(P, ['platform_owner']), request.id, { step_index: 1 }, ctx);
    expect(done.apply).toMatchObject({ applied: false, reason: 'POLICY_ACTIVE_CHANGED', detail: { request_policy_version_id: POLICY_V1, active_policy_version_id: V3 } });
    const snap = await snapshotOf(request.id);
    expect(await statusOf(V2)).toBe('DRAFT');
    expect(await statusOf(V3)).toBe('ACTIVE');
    await svc.applyPolicyActivation(as(P, ['platform_owner']), request.id, ctx);
    expect(await snapshotOf(request.id)).toEqual(snap);
  });

  it('B5-NC5-c the target changed after the approvers saw it: the draft is locked through the service while the request is pending, and a write that bypasses it makes the apply refuse TARGET_CHANGED', async () => {
    const { FA, FA2, P } = await cast();
    const V2 = await draft(P, ['platform_owner'], { approval_expiry_hours: 48 });
    const id = await activationRequest(FA, V2);
    expect(await outcome(gov.updateDraft(as(P, ['platform_owner']), V2, { content: { approval_expiry_hours: 36 } }, ctx))).toBe('STATE_INVALID:policy_version_locked');
    await svc.approve(as(FA2, ['finance_admin']), id, { step_index: 0 }, ctx);
    const v = (await pg.query(`SELECT content FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [V2])).rows[0].content as Record<string, unknown>;
    const edited = { ...v, approval_expiry_hours: 36 };
    await pg.query(`UPDATE subscription."CommercialPolicyVersion" SET content = $2::jsonb, content_checksum = $3 WHERE id = $1`, [V2, JSON.stringify(edited), commercialPolicyChecksum(edited)]);
    const done = await svc.approve(as(P, ['platform_owner']), id, { step_index: 1 }, ctx);
    expect(done.apply).toMatchObject({ applied: false, reason: 'TARGET_CHANGED' });
    expect(await statusOf(V2)).toBe('DRAFT');
    expect(await statusOf(POLICY_V1)).toBe('ACTIVE');
  });

  it('B5-ROLLBACK-1 a RETIRED version is re-activated by a POLICY_ACTIVATE (rollback): v1 ACTIVE again, v2 RETIRED, the activation event says rollback', async () => {
    const { FA, FA2, P } = await cast();
    const V2 = await draft(FA, ['finance_admin'], { approval_expiry_hours: 48 });
    const a = await activationRequest(FA, V2);
    await svc.approve(as(FA2, ['finance_admin']), a, { step_index: 0 }, ctx);
    await svc.approve(as(P, ['platform_owner']), a, { step_index: 1 }, ctx);
    const b = await activationRequest(FA, POLICY_V1);
    await svc.approve(as(FA2, ['finance_admin']), b, { step_index: 0 }, ctx);
    const done = await svc.approve(as(P, ['platform_owner']), b, { step_index: 1 }, ctx);
    expect(done.apply).toMatchObject({ applied: true, detail: { from_version_id: V2, to_version_id: POLICY_V1, rollback: true } });
    expect((await versions()).map((x) => x.status)).toEqual(['ACTIVE', 'RETIRED']);
    const ev = (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_POLICY_VERSION_ACTIVATED'`, [b])).rows[0].payload;
    expect(ev).toMatchObject({ rollback: true, replaces: V2 });
  });

  it('B5-CREATE-1 the activation request snapshot: a stale snapshot, an unknown payload key, an ACTIVE target and a second open request are refused', async () => {
    const { FA } = await cast();
    const V2 = await draft(FA, ['finance_admin']);
    const create = (payload: Record<string, unknown>) => svc.create(as(FA, ['finance_admin']), { action_type: 'POLICY_ACTIVATE', payload, reason: 'x', idempotency_key: key() }, ctx);
    expect(await outcome(create({ policy_version_id: V2, target_content_checksum: 'a'.repeat(64) }))).toBe('INVALID_INPUT:policy_version_changed');
    expect(await outcome(create({ policy_version_id: V2, note: 'x' }))).toBe('INVALID_INPUT:invalid_payload');
    expect(await outcome(create({ policy_version_id: POLICY_V1 }))).toBe('INVALID_INPUT:policy_version_already_active');
    expect(await outcome(create({ policy_version_id: V2 }))).toBe('OK');
    expect(await outcome(create({ policy_version_id: V2 }))).toBe('OPEN_REQUEST_EXISTS:open_policy_request_exists');
  });

  // ---- drafts ---------------------------------------------------------------------------

  it('B5-DRAFT-1 authoring: only platform_owner / finance_admin author; one DRAFT at a time; ranges and the strict parser apply; only a DRAFT changes; every write is audited', async () => {
    const { FA, P } = await cast();
    const OPS = await addOperator(pg, ['commercial_ops']);
    const AUD = await addOperator(pg, ['read_only_auditor']);
    expect(await outcome(gov.createDraft(as(OPS, ['commercial_ops']), { source_version_id: POLICY_V1 }, ctx))).toBe('REQUESTER_ROLE_MISSING');
    expect(await outcome(gov.createDraft(as(AUD, ['read_only_auditor']), { source_version_id: POLICY_V1 }, ctx))).toBe('REQUESTER_ROLE_MISSING');
    const v2 = await gov.createDraft(as(P, ['platform_owner']), { source_version_id: POLICY_V1 }, ctx);
    expect(v2).toMatchObject({ version_number: 2, status: 'DRAFT', note: 'Draft from v1', created_by: P });
    expect(await outcome(gov.createDraft(as(FA, ['finance_admin']), { source_version_id: POLICY_V1 }, ctx))).toBe('STATE_INVALID:policy_draft_exists');
    expect(await outcome(gov.updateDraft(as(FA, ['finance_admin']), v2.id, { content: { approval_expiry_hours: 200 } }, ctx))).toBe('INVALID_INPUT:policy_value_out_of_range');
    expect(await outcome(gov.updateDraft(as(FA, ['finance_admin']), v2.id, { content: { discount_escalation_threshold_bps: 0 } }, ctx))).toBe('INVALID_INPUT:policy_value_invalid');
    expect(await outcome(gov.updateDraft(as(FA, ['finance_admin']), v2.id, { content: { currency: 'EUR' } }, ctx))).toBe('INVALID_INPUT:policy_key_not_editable');
    expect(await outcome(gov.updateDraft(as(FA, ['finance_admin']), POLICY_V1, { content: { approval_expiry_hours: 48 } }, ctx))).toBe('STATE_INVALID:policy_version_not_draft');
    expect(await outcome(gov.updateDraft(as(OPS, ['commercial_ops']), v2.id, { content: { approval_expiry_hours: 48 } }, ctx))).toBe('REQUESTER_ROLE_MISSING');
    const edited = await gov.updateDraft(as(FA, ['finance_admin']), v2.id, { content: { approval_expiry_hours: 48, credit_escalation_threshold_minor: 30_000 }, note: 'Tighten after Q3' }, ctx);
    expect(edited.content).toMatchObject({ approval_expiry_hours: 48, credit_escalation_threshold_minor: 30_000 });
    expect(edited.content_checksum).toBe(commercialPolicyChecksum(edited.content));
    expect(edited.note).toBe('Tighten after Q3');
    const ev = (await pg.query(`SELECT event_type, payload, actor_role_keys FROM subscription."CommercialAuditEvent" WHERE subject = $1 ORDER BY created_at, id`, [`commercial_policy_version:${v2.id}`])).rows;
    expect(ev.map((e) => e.event_type)).toEqual(['COMMERCIAL_POLICY_VERSION_DRAFTED', 'COMMERCIAL_POLICY_DRAFT_UPDATED']);
    expect(ev[1].payload).toMatchObject({ changed_keys: ['credit_escalation_threshold_minor', 'approval_expiry_hours'], before: { approval_expiry_hours: 72, credit_escalation_threshold_minor: 50_000 }, after: { approval_expiry_hours: 48, credit_escalation_threshold_minor: 30_000 } });
    expect(ev[1].actor_role_keys).toEqual(['finance_admin']);
    expect(await count(`SELECT count(*)::int AS n FROM subscription."CommercialPolicyAuditEvent" WHERE subject_id = $1 AND event_type = 'COMMERCIAL_POLICY_VERSION_CREATED'`, [v2.id])).toBe(1);
    // The caller flags of the list read (live roles).
    expect((await gov.list(as(FA, ['finance_admin']), ctx)).caller).toEqual({ can_author: true, can_request_activation: true });
    expect((await gov.list(as(P, ['platform_owner']), ctx)).caller).toEqual({ can_author: true, can_request_activation: false });
    expect((await gov.list(as(AUD, ['read_only_auditor']), ctx)).caller).toEqual({ can_author: false, can_request_activation: false });
    const list = await gov.list(as(AUD, ['read_only_auditor']), ctx);
    expect(list.versions.map((v) => [v.row.version_number, v.row.status])).toEqual([[2, 'DRAFT'], [1, 'ACTIVE']]);
    expect(list.active_version_id).toBe(POLICY_V1);
  });

  // ---- the audit export -----------------------------------------------------------------

  it('B5-EXPORT-1 the export is read-only: every table is unchanged except ONE new COMMERCIAL_AUDIT_EXPORTED event; existing audit rows are byte-identical; the CSV holds every filtered event; filters narrow it', async () => {
    const { FA2 } = await cast();
    const AUD = await addOperator(pg, ['read_only_auditor']);
    const OPS = await addOperator(pg, ['commercial_ops']);
    await pg.query(`UPDATE identity."User" SET display_name = 'Tomás Silva' WHERE id = $1`, [OPS]);
    const { request } = await svc.create(as(OPS, ['commercial_ops']), { action_type: 'CREDIT', tenant_id: TENANT_1, product_key: 'sign', payload: { amount_minor: 100, currency: 'USD' }, reason: 'credit', idempotency_key: key() }, ctx);
    await svc.submit(as(OPS, ['commercial_ops']), request.id, ctx);
    await svc.approve(as(FA2, ['finance_admin']), request.id, { step_index: 0 }, ctx);
    const tables = (
      await pg.query(`SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_tables WHERE schemaname IN ('identity', 'subscription', 'metering') ORDER BY 1`)
    ).rows.map((r) => r.t as string);
    const footprint = async () => {
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = await count(`SELECT count(*)::int AS n FROM ${t}`);
      return out;
    };
    const auditDigest = async () => (await pg.query(`SELECT md5(string_agg(row_to_json(e)::text, '|' ORDER BY id)) AS d FROM subscription."CommercialAuditEvent" e WHERE event_type <> 'COMMERCIAL_AUDIT_EXPORTED'`)).rows[0].d as string;
    const before = await footprint();
    const digest = await auditDigest();
    const total = await count(`SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent"`);
    const out = await exporter.export(as(AUD, ['read_only_auditor']), {}, ctx);
    expect(out.row_count).toBe(total);
    const lines = out.csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('id,time_utc,event,actor,roles,tenant,product,change_request,exception,detail');
    expect(lines).toHaveLength(total + 1);
    expect(out.csv).toContain('"Tomás Silva"');
    expect(out.csv).toContain('"Tenant One"');
    expect(out.csv_sha256).toBe(createHash('sha256').update(out.csv, 'utf8').digest('hex'));
    const after = await footprint();
    const delta = Object.fromEntries(tables.map((t) => [t, (after[t] ?? 0) - (before[t] ?? 0)]).filter(([, d]) => d !== 0));
    expect(delta).toEqual({ 'subscription."CommercialAuditEvent"': 1 });
    expect(await auditDigest()).toBe(digest);
    const ev = (await pg.query(`SELECT * FROM subscription."CommercialAuditEvent" WHERE event_type = 'COMMERCIAL_AUDIT_EXPORTED'`)).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_id: AUD, actor_role_keys: ['read_only_auditor'], subject: `commercial_audit_export:${out.export_id}`, is_exception: false, change_request_id: null });
    expect(ev[0].payload).toMatchObject({ format: 'csv', row_count: total, csv_sha256: out.csv_sha256, filters: {} });
    // Filters: change request, product, exception-only.
    const byRequest = await exporter.export(as(AUD, ['read_only_auditor']), { change_request_id: request.id }, ctx);
    expect(byRequest.row_count).toBe((await eventsOf(request.id)).length);
    const bySign = await exporter.export(as(AUD, ['read_only_auditor']), { product_key: 'sign' }, ctx);
    expect(bySign.row_count).toBe(await count(`SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent" WHERE payload->>'product_key' = 'sign'`));
    expect(bySign.row_count).toBeGreaterThan(0);
    const exc = await exporter.export(as(AUD, ['read_only_auditor']), { exception_only: true }, ctx);
    expect(exc.row_count).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent" WHERE event_type = 'COMMERCIAL_AUDIT_EXPORTED'`)).toBe(4);
  });

  it('B5-EXPORT-2 the export is bounded: more than 10,000 matching events is refused, and the refusal writes no export event', async () => {
    const AUD = await addOperator(pg, ['read_only_auditor']);
    await pg.query(
      `INSERT INTO subscription."CommercialAuditEvent" (id, actor_type, event_type, subject, policy_version_id, payload, correlation_id)
       SELECT gen_random_uuid(), 'system', 'B5_BULK_FIXTURE', 'fixture:' || g, $1, '{}'::jsonb, 'b5' FROM generate_series(1, 10001) g`,
      [POLICY_V1],
    );
    expect(await outcome(exporter.export(as(AUD, ['read_only_auditor']), { event_type: 'B5_BULK_FIXTURE' }, ctx))).toBe('EXPORT_TOO_LARGE');
    expect(await count(`SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent" WHERE event_type = 'COMMERCIAL_AUDIT_EXPORTED'`)).toBe(0);
  });

  // ---- the roster -----------------------------------------------------------------------

  it('B5-ROSTER-1 the roster names each operator with live roles, attestation, the last-owner flag and pending role requests; chain fulfillability follows the live roster per chain', async () => {
    const P = await addOperator(pg, ['platform_owner']);
    await addOperator(pg, ['finance_admin']);
    await addOperator(pg, ['commercial_ops']);
    const SA = await addOperator(pg, ['super_admin'], { attested: false });
    let view = await roster.read(PLATFORM_TENANT);
    const op = (id: string) => view.operators.find((o) => o.user_id === id);
    expect(op(P)).toMatchObject({ commercial_role_keys: ['platform_owner'], is_last_owner: true, attested: true, email: `${P}@ops.test` });
    expect(op(SA)).toMatchObject({ role_keys: ['super_admin'], commercial_role_keys: [], attested: false, is_last_owner: false });
    const chain = (k: string) => view.chains.find((c) => c.key === k);
    // One finance_admin and one owner: the commercial_ops chains are fulfillable; a role change
    // needs a distinct second owner; a policy change needs a second finance_admin (the maker).
    expect(chain('BELOW_THRESHOLD')).toMatchObject({ fulfillable: true, rule: 'FINANCE_ONLY', maker_roles: ['commercial_ops', 'support_admin'] });
    expect(chain('ABOVE_THRESHOLD')).toMatchObject({ fulfillable: true, rule: 'FINANCE_THEN_OWNER', step_roles: ['finance_admin', 'platform_owner'], maker_roles: ['commercial_ops'] });
    expect(chain('CATALOG_PUBLISH')).toMatchObject({ fulfillable: false, missing: 'maker', maker_roles: ['catalog_manager'] });
    expect(chain('ROLE_CHANGE')).toMatchObject({ fulfillable: false, missing: 'steps', step_roles: ['platform_owner'] });
    expect(chain('POLICY_CHANGE')).toMatchObject({ fulfillable: false, missing: 'steps', maker_roles: ['finance_admin'] });
    expect(view.all_fulfillable).toBe(false);
    const P2 = await addOperator(pg, ['platform_owner']);
    await addOperator(pg, ['finance_admin']);
    await addOperator(pg, ['catalog_manager']);
    const X = await addOperator(pg, ['read_only_auditor']);
    const { request } = await svc.create(as(P, ['platform_owner']), { action_type: 'ROLE_GRANT', payload: { subject_user_id: X, role_key: 'support_admin' }, reason: 'cover', idempotency_key: key() }, ctx);
    view = await roster.read(PLATFORM_TENANT);
    expect(view.all_fulfillable).toBe(true);
    expect(op(P)?.is_last_owner).toBe(false);
    expect(op(P2)?.is_last_owner).toBe(false);
    expect(op(X)?.pending_role_requests).toEqual([{ id: request.id, action_type: 'ROLE_GRANT', role_key: 'support_admin', state: 'DRAFT' }]);
  });

  it('B5-ROLE-1 the governed role change is the only grant path: a last-owner revoke is refused at create (409 PLATFORM_LAST_OWNER), and nothing in B5 writes an identity role', async () => {
    const P = await addOperator(pg, ['platform_owner']);
    expect(await outcome(svc.create(as(P, ['platform_owner']), { action_type: 'ROLE_REVOKE', payload: { subject_user_id: P, role_key: 'platform_owner' }, reason: 'x', idempotency_key: key() }, ctx))).toBe('LAST_OWNER:platform_last_owner');
    const before = await count(`SELECT count(*)::int AS n FROM identity."UserTenantMembershipRole"`);
    await roster.read(PLATFORM_TENANT);
    await gov.list(as(P, ['platform_owner']), ctx);
    await exporter.export(as(P, ['platform_owner']), {}, ctx);
    expect(await count(`SELECT count(*)::int AS n FROM identity."UserTenantMembershipRole"`)).toBe(before);
  });
});
