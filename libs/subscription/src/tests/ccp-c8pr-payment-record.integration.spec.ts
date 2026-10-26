import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BillingFinanceReportService } from '../lib/billing/billing-finance-report.service.js';
import { CommercialApplyFailedError, type CommercialApplyFaultPoint } from '../lib/commercial/commercial-apply.service.js';
import { CommercialChangeRequestError } from '../lib/commercial/commercial-change-request.service.js';
import { ContractPaymentReadService } from '../lib/commercial/commercial-payment-record.js';
import { CommercialAlertService } from '../lib/observability/commercial-alert.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { addOperator, applyCcpA6Schema, grantRole, revokeRole } from './support/ccp-a3-database.js';
import { A6_CTX, ENTERPRISE, a6Harness, as, newTenant, publishedVersion, rawSubscription, type A6Harness } from './support/ccp-a6.js';

// CCP-C8-PR (Aramo-CCP-Program-Build-Directive-Amendment-A2-Payment-Record-v1_0-LOCKED §6 tests) on real
// Postgres 17 with identity + entitlement + metering + EVERY subscription migration (whole-file applier):
// per-role creation, the PR-3 chain variants (resolved at create, never later), duplicates, mismatches, the
// PR-7 gate (no receipt → refused; exact → applies; POSTPAID), the full §4.3 sequence with a failure injected
// at each step (rollback leaves the receipt unlinked and reusable), cross-tenant linkage refused, PR-9
// corrections, PR-10 through the read model, TenantSubscription.status never written, Q14 concurrency, the
// C6 listing and the D3 alert of an unlinked receipt. Test IDs are cited by doc/ccp/slices/CCP-C8PR-acceptance.md.

const T0 = new Date('2026-10-25T12:00:00.000Z');
const SHA = (c: string): string => c.repeat(64).slice(0, 64);
const DOC = { name: 'Remittance advice.pdf', sha256: SHA('7e1d0a'), byte_size: 20480, media_type: 'application/pdf' };
const AMOUNT = 1_200_000;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-C8-PR PAYMENT_RECORD (real Postgres 17)', { timeout: 300_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: A6Harness;
  let fault: CommercialApplyFaultPoint | null = null;
  let OPS: string;
  let FA1: string;
  let FA2: string;
  let PO: string;
  let PO2: string;
  let SUPPORT: string;
  let AUDITOR: string;
  let CATALOG: string;
  let keyN = 0;
  let refN = 0;
  let payN = 0;
  const key = () => `c8pr-key-${String(++keyN).padStart(6, '0')}`;
  const ref = () => `CT-C8PR-${String(100 + ++refN)}`;
  const payRef = () => `WIRE-${String(++payN).padStart(5, '0')}`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = a6Harness(prisma, () => T0, async (point) => {
      if (point === fault) throw new Error(`injected fault at ${point}`);
    });
    OPS = await addOperator(pg, ['commercial_ops']);
    FA1 = await addOperator(pg, ['finance_admin']);
    PO = await addOperator(pg, ['platform_owner']);
    PO2 = await addOperator(pg, ['platform_owner']);
    SUPPORT = await addOperator(pg, ['support_admin']);
    AUDITOR = await addOperator(pg, ['read_only_auditor']);
    CATALOG = await addOperator(pg, ['catalog_manager']);
    // FA2 is added by C8PR-CHAIN-2 (the roster has ONE finance_admin until then).
  }, 600_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  // ---- builders ------------------------------------------------------------------------------

  const evidence = (o: Record<string, unknown> = {}) => ({
    external_invoice_ref: 'INV-2026-0042',
    amount_minor: AMOUNT,
    currency: 'USD',
    received_on: '2026-10-20',
    payment_method: 'BANK_TRANSFER',
    payment_reference: payRef(),
    verification: 'Matched on the bank statement of 2026-10-20',
    evidence_documents: [DOC],
    origin: 'MANUAL',
    ...o,
  });
  const provisional = (contract_ref: string, o: Record<string, unknown> = {}, expected = AMOUNT) => ({
    operation: 'RECORD',
    target: { kind: 'PROVISIONAL_INITIAL', contract_ref, obligation_ref: 'INITIAL', expected_amount_minor: expected, expected_currency: 'USD' },
    ...evidence(o),
  });
  const linked = (contract_ref: string, obligation_ref: string, o: Record<string, unknown> = {}) => ({ operation: 'RECORD', target: { kind: 'CONTRACT_OBLIGATION', contract_ref, obligation_ref }, ...evidence(o) });
  const prepaidTerms = (initial = AMOUNT, extra: Array<Record<string, unknown>> = [], o: Record<string, unknown> = {}) => ({
    billing_mode: 'PREPAID',
    currency: 'USD',
    timezone: 'America/New_York',
    obligations: [{ obligation_ref: 'INITIAL', due_date: '2026-11-01', amount_minor: initial, description: 'Year 1 prepaid fee' }, ...extra],
    ...o,
  });
  const postpaidTerms = (obligations: Array<Record<string, unknown>> = [], o: Record<string, unknown> = {}) => ({
    billing_mode: 'POSTPAID',
    postpaid_approval: { statement: 'Postpaid, invoiced quarterly in arrears (MSA §4.2)', evidence_ref: 'MSA §4.2' },
    currency: 'USD',
    timezone: 'America/New_York',
    obligations,
    ...o,
  });
  const openPayload = async (contract_ref: string, payment_terms: Record<string, unknown>) => ({
    plan_key: ENTERPRISE,
    plan_version_id: await publishedVersion(pg, ENTERPRISE),
    replaces_subscription_id: null,
    contract: { contract_ref, terms: ['Sign Enterprise at a negotiated annual price'], documents: [], evidence_ref: 'Order form', payment_terms },
  });

  async function create(action_type: 'PAYMENT_RECORD' | 'SUBSCRIPTION_OPEN' | 'SUBSCRIPTION_CHANGE', tenant_id: string, payload: Record<string, unknown>, requester = OPS, role = 'commercial_ops'): Promise<string> {
    const r = await h.changeRequests.create(as(requester, role), { action_type, tenant_id, product_key: 'sign', payload, reason: `C8-PR ${action_type}`, idempotency_key: key() }, A6_CTX);
    return r.request.id;
  }
  /** create → submit → approve the snapshotted chain (finance step by `fa`, owner step by PO). */
  async function approved(action_type: 'PAYMENT_RECORD' | 'SUBSCRIPTION_OPEN' | 'SUBSCRIPTION_CHANGE', tenant_id: string, payload: Record<string, unknown>, requester = OPS, role = 'commercial_ops', fa = FA1): Promise<string> {
    const id = await create(action_type, tenant_id, payload, requester, role);
    await h.changeRequests.submit(as(requester, role), id, A6_CTX);
    const chain = (await pg.query(`SELECT required_chain FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].required_chain as { steps: Array<{ role_key: string }> };
    for (const [i, s] of chain.steps.entries()) {
      const r = await h.changeRequests.approve(s.role_key === 'finance_admin' ? as(fa, 'finance_admin') : as(PO, 'platform_owner'), id, { step_index: i }, A6_CTX);
      if (i === chain.steps.length - 1) expect(r.request.state).toBe('APPROVED');
    }
    return id;
  }
  const applyAs = (id: string, requester = OPS, role = 'commercial_ops') => h.apply.apply(as(requester, role), id, A6_CTX);
  async function applied(action_type: 'PAYMENT_RECORD' | 'SUBSCRIPTION_OPEN' | 'SUBSCRIPTION_CHANGE', tenant_id: string, payload: Record<string, unknown>, requester = OPS, role = 'commercial_ops'): Promise<string> {
    const id = await approved(action_type, tenant_id, payload, requester, role);
    const out = await applyAs(id, requester, role);
    expect(out.request.state).toBe('APPLIED');
    return id;
  }
  async function refusal(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return 'CREATED';
    } catch (e) {
      if (e instanceof CommercialChangeRequestError) return e.code === 'PAYMENT_REFUSED' ? `REFUSED:${String(e.details['refusal'])}` : e.code === 'INVALID_INPUT' ? `INVALID:${((e.details['codes'] as string[] | undefined) ?? []).join(',')}` : e.code;
      throw e;
    }
  }
  async function outcome(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return 'APPLIED';
    } catch (e) {
      if (e instanceof CommercialApplyFailedError) return `FAILED:${e.code}`;
      throw e;
    }
  }
  const receiptOf = async (change_request_id: string) => (await pg.query(`SELECT * FROM subscription."CommercialPaymentReceipt" WHERE change_request_id = $1`, [change_request_id])).rows[0];
  const stateOf = async (id: string) => (await pg.query(`SELECT state FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].state as string;
  /** A tenant whose PREPAID contract opened with its INITIAL receipt (the K-2 sequence). */
  async function prepaidOpened(extra: Array<Record<string, unknown>> = [], o: Record<string, unknown> = {}): Promise<{ t: string; contract_ref: string; contract_id: string; receipt_cr: string; open_cr: string }> {
    const t = await newTenant(pg);
    const contract_ref = ref();
    const receipt_cr = await applied('PAYMENT_RECORD', t, provisional(contract_ref));
    const open_cr = await applied('SUBSCRIPTION_OPEN', t, await openPayload(contract_ref, prepaidTerms(AMOUNT, extra, o)));
    const contract_id = (await pg.query(`SELECT id FROM subscription."Contract" WHERE contract_ref = $1`, [contract_ref])).rows[0].id as string;
    return { t, contract_ref, contract_id, receipt_cr, open_cr };
  }
  const subscriptions = async (t: string) => (await pg.query(`SELECT row_to_json(s)::text j FROM subscription."TenantSubscription" s WHERE tenant_id = $1 ORDER BY id`, [t])).rows.map((r) => r.j as string);

  // ---- PR-3 chain variants (first: the roster holds ONE finance_admin) --------------------------

  it('C8PR-CHAIN-1 a finance_admin requester with no other eligible finance_admin at creation → the Platform Owner exception, snapshotted with its basis; the owner approves and the requester applies', async () => {
    const t = await newTenant(pg);
    const id = await create('PAYMENT_RECORD', t, provisional(ref()), FA1, 'finance_admin');
    const chain = (await pg.query(`SELECT required_chain FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].required_chain;
    expect(chain).toMatchObject({ rule: 'DISTINCT_PLATFORM_OWNER', basis: { exception: true, requester_role: 'finance_admin', finance_chain_fulfillable: false }, steps: [{ role_key: 'platform_owner', scope_keys: ['platform:billing:approve'] }] });
    const created = (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_CHANGE_REQUEST_CREATED'`, [id])).rows[0].payload;
    expect(created).toMatchObject({ chain_rule: 'DISTINCT_PLATFORM_OWNER', chain_basis: { exception: true } });
    // PR-3 "it is never chosen afterwards": a second finance_admin arriving later changes nothing.
    FA2 = await addOperator(pg, ['finance_admin']);
    await h.changeRequests.submit(as(FA1, 'finance_admin'), id, A6_CTX);
    // The requester never fills a step; a finance_admin cannot fill the owner step.
    await expect(h.changeRequests.approve(as(FA1, 'finance_admin'), id, { step_index: 0 }, A6_CTX)).rejects.toMatchObject({ refusal: 'SELF_APPROVAL' });
    await expect(h.changeRequests.approve(as(FA2, 'finance_admin'), id, { step_index: 0 }, A6_CTX)).rejects.toMatchObject({ refusal: 'STEP_SCOPE_MISSING' });
    expect((await pg.query(`SELECT required_chain FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].required_chain).toEqual(chain);
    await h.changeRequests.approve(as(PO, 'platform_owner'), id, { step_index: 0 }, A6_CTX);
    expect((await applyAs(id, FA1, 'finance_admin')).request.state).toBe('APPLIED');
  });

  it('C8PR-CHAIN-2 a finance_admin requester with another eligible finance_admin → Finance filled by a DIFFERENT finance_admin; losing that approver later never switches to the owner (refused at apply instead, NC-5)', async () => {
    const t = await newTenant(pg);
    const id = await create('PAYMENT_RECORD', t, provisional(ref()), FA1, 'finance_admin');
    const chain = (await pg.query(`SELECT required_chain FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].required_chain;
    expect(chain).toMatchObject({ rule: 'FINANCE_ONLY', basis: { requester_role: 'finance_admin', finance_chain_fulfillable: true }, steps: [{ role_key: 'finance_admin' }] });
    await h.changeRequests.submit(as(FA1, 'finance_admin'), id, A6_CTX);
    await expect(h.changeRequests.approve(as(PO, 'platform_owner'), id, { step_index: 0 }, A6_CTX)).rejects.toMatchObject({ refusal: 'STEP_SCOPE_MISSING' });
    await h.changeRequests.approve(as(FA2, 'finance_admin'), id, { step_index: 0 }, A6_CTX);
    await revokeRole(pg, FA2, 'finance_admin');
    try {
      await expect(applyAs(id, FA1, 'finance_admin')).rejects.toMatchObject({ reason: 'APPROVER_NO_LONGER_ELIGIBLE' });
      expect((await pg.query(`SELECT required_chain FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].required_chain).toEqual(chain);
    } finally {
      await grantRole(pg, FA2, 'finance_admin');
    }
    expect((await applyAs(id, FA1, 'finance_admin')).request.state).toBe('APPLIED');
  });

  it('C8PR-CHAIN-3 a commercial_ops requester → FINANCE_ONLY; CORRECT (any requester) → Finance → Owner', async () => {
    const t = await newTenant(pg);
    const rec = await applied('PAYMENT_RECORD', t, provisional(ref()));
    expect((await pg.query(`SELECT required_chain FROM subscription."CommercialChangeRequest" WHERE id = $1`, [rec])).rows[0].required_chain).toMatchObject({ rule: 'FINANCE_ONLY', basis: { requester_role: 'commercial_ops' } });
    const receipt = await receiptOf(rec);
    const cor = await create('PAYMENT_RECORD', t, { operation: 'CORRECT', corrects_receipt_id: receipt.id, correction: 'VOID', correction_reason: 'The deal was cancelled before signature', no_contract_will_follow: true });
    expect((await pg.query(`SELECT required_chain FROM subscription."CommercialChangeRequest" WHERE id = $1`, [cor])).rows[0].required_chain).toMatchObject({ rule: 'FINANCE_THEN_OWNER', steps: [{ role_key: 'finance_admin' }, { role_key: 'platform_owner' }] });
    await h.changeRequests.withdraw(as(OPS, 'commercial_ops'), cor, A6_CTX);
  });

  // ---- per-role creation ----------------------------------------------------------------------

  it('C8PR-ROLE-1 only commercial_ops and finance_admin may request PAYMENT_RECORD (platform:payment:request); every other role and super_admin are refused', async () => {
    const t = await newTenant(pg);
    for (const [user, role] of [[PO, 'platform_owner'], [SUPPORT, 'support_admin'], [AUDITOR, 'read_only_auditor'], [CATALOG, 'catalog_manager'], [PO2, 'super_admin']] as const) {
      expect(await refusal(create('PAYMENT_RECORD', t, provisional(ref()), user, role)), role).toBe('REQUESTER_SCOPE_MISSING');
    }
    const a = await create('PAYMENT_RECORD', t, provisional(ref()), OPS, 'commercial_ops');
    await h.changeRequests.withdraw(as(OPS, 'commercial_ops'), a, A6_CTX);
    const b = await create('PAYMENT_RECORD', t, provisional(ref()), FA1, 'finance_admin');
    await h.changeRequests.withdraw(as(FA1, 'finance_admin'), b, A6_CTX);
    // A holder of the scope without either role (a hand-built token) has no defined chain: refused.
    expect(await refusal(h.changeRequests.create(as(SUPPORT, 'support_admin', { scopes: ['platform:payment:request'] }), { action_type: 'PAYMENT_RECORD', tenant_id: t, product_key: 'sign', payload: provisional(ref()), reason: 'x', idempotency_key: key() }, A6_CTX))).toBe('REQUESTER_AUTHORITY_UNDEFINED');
    // Apply is requester-only (TD-B2-3).
    const c = await approved('PAYMENT_RECORD', t, provisional(ref()));
    await expect(applyAs(c, FA1, 'finance_admin')).rejects.toMatchObject({ code: 'NOT_REQUESTER' });
    expect((await applyAs(c)).request.state).toBe('APPLIED');
  });

  // ---- PR-7 activation gate and the §4.3 sequence -------------------------------------------------

  it('C8PR-GATE-1 a PREPAID SUBSCRIPTION_OPEN without its INITIAL receipt is refused (PAYMENT_NOT_RECORDED, audited); with an exact receipt it applies and links it', async () => {
    const t = await newTenant(pg);
    const contract_ref = ref();
    expect(await refusal(create('SUBSCRIPTION_OPEN', t, await openPayload(contract_ref, prepaidTerms())))).toBe('REFUSED:PAYMENT_NOT_RECORDED');
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialAuditEvent" WHERE tenant_id = $1 AND event_type = 'COMMERCIAL_PAYMENT_REFUSED' AND payload ->> 'refusal' = 'PAYMENT_NOT_RECORDED'`, [t])).rows[0].n).toBe(1);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest" WHERE tenant_id = $1`, [t])).rows[0].n).toBe(0);
    const rec = await applied('PAYMENT_RECORD', t, provisional(contract_ref));
    const r0 = await receiptOf(rec);
    expect(r0).toMatchObject({ linked_at: null, contract_id: null, obligation_id: null, provisional_contract_ref: contract_ref, provisional_obligation_ref: 'INITIAL', entry_kind: 'RECORD', corrected_at: null });
    // Recording a payment never opens a subscription (PR-7).
    expect(await subscriptions(t)).toEqual([]);
    const open = await applied('SUBSCRIPTION_OPEN', t, await openPayload(contract_ref, prepaidTerms(AMOUNT, [{ obligation_ref: 'Y2', due_date: '2027-11-01', amount_minor: AMOUNT, description: 'Year 2' }])));
    const contract = (await pg.query(`SELECT * FROM subscription."Contract" WHERE contract_ref = $1`, [contract_ref])).rows[0];
    expect(contract).toMatchObject({ billing_mode: 'PREPAID', payment_currency: 'USD', payment_timezone: 'America/New_York', grace_days: null, postpaid_approval: null });
    const obligations = (await pg.query(`SELECT obligation_ref, to_char(due_date, 'YYYY-MM-DD') d, amount_minor::int a FROM subscription."ContractPaymentObligation" WHERE contract_id = $1 ORDER BY obligation_ref`, [contract.id])).rows;
    expect(obligations).toEqual([{ obligation_ref: 'INITIAL', d: '2026-11-01', a: AMOUNT }, { obligation_ref: 'Y2', d: '2027-11-01', a: AMOUNT }]);
    const r1 = await receiptOf(rec);
    expect(r1.contract_id).toBe(contract.id);
    expect(r1.linked_by_change_request_id).toBe(open);
    expect(r1.linked_at).not.toBeNull();
    const ev = (await pg.query(`SELECT event_type FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [open])).rows.map((r) => r.event_type);
    expect(ev).toEqual(expect.arrayContaining(['COMMERCIAL_SUBSCRIPTION_OPENED', 'COMMERCIAL_CONTRACT_RECORDED', 'COMMERCIAL_PAYMENT_RECEIPT_LINKED', 'COMMERCIAL_ENTITLEMENT_GRANTED', 'COMMERCIAL_CHANGE_REQUEST_APPLIED']));
    expect(ev.indexOf('COMMERCIAL_CONTRACT_RECORDED')).toBeLessThan(ev.indexOf('COMMERCIAL_PAYMENT_RECEIPT_LINKED'));
    expect(ev.indexOf('COMMERCIAL_PAYMENT_RECEIPT_LINKED')).toBeLessThan(ev.indexOf('COMMERCIAL_ENTITLEMENT_GRANTED'));
    // N-3(b): the contract keeps its NOT NULL FK to the subscription, created in the same transaction.
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."TenantSubscription" WHERE id = $1 AND tenant_id = $2`, [contract.tenant_subscription_id, t])).rows[0].n).toBe(1);
  });

  it('C8PR-GATE-2 a mismatched INITIAL receipt refuses the open (PAYMENT_OBLIGATION_MISMATCH); POSTPAID opens with no payment precondition; a POSTPAID without its marker or a contract without billing_mode is refused', async () => {
    const t = await newTenant(pg);
    const contract_ref = ref();
    await applied('PAYMENT_RECORD', t, provisional(contract_ref, { amount_minor: 900_000 }, 900_000));
    expect(await refusal(create('SUBSCRIPTION_OPEN', t, await openPayload(contract_ref, prepaidTerms(AMOUNT))))).toBe('REFUSED:PAYMENT_OBLIGATION_MISMATCH');
    const t2 = await newTenant(pg);
    const post = await applied('SUBSCRIPTION_OPEN', t2, await openPayload(ref(), postpaidTerms([{ obligation_ref: 'Q1', due_date: '2027-01-31', amount_minor: 300_000, description: 'Q1 in arrears' }])));
    expect(await stateOf(post)).toBe('APPLIED');
    const t3 = await newTenant(pg);
    const { postpaid_approval: _m, ...noMarker } = postpaidTerms();
    expect(await refusal(create('SUBSCRIPTION_OPEN', t3, await openPayload(ref(), noMarker)))).toBe('INVALID:POSTPAID_APPROVAL_REQUIRED');
    const { billing_mode: _b, ...noMode } = prepaidTerms();
    expect(await refusal(create('SUBSCRIPTION_OPEN', t3, await openPayload(ref(), noMode)))).toBe('INVALID:BILLING_MODE_REQUIRED');
    expect(await refusal(create('SUBSCRIPTION_OPEN', t3, await openPayload(ref(), prepaidTerms(AMOUNT, [], { obligations: [] }))))).toBe('INVALID:INITIAL_OBLIGATION_REQUIRED');
    // The DB backstop: a CHANGE_REQUEST contract without payment terms is refused by the insert trigger.
    const v = await publishedVersion(pg, ENTERPRISE);
    const raw = await create('SUBSCRIPTION_OPEN', t3, { plan_key: ENTERPRISE, plan_version_id: v, replaces_subscription_id: null });
    await pg.query('BEGIN');
    try {
      await pg.query(`SET LOCAL session_replication_role = replica`);
      await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', submitted_at = now(), expires_at = now() + interval '72 hours' WHERE id = $1`, [raw]);
      const sub = await rawSubscription(pg, t3, { source: 'MANUAL', plan: ENTERPRISE });
      await pg.query(`SET LOCAL session_replication_role = origin`);
      await expect(
        pg.query(`INSERT INTO subscription."Contract" (id, contract_ref, tenant_subscription_id, terms, evidence_documents, provenance, recorded_by_change_request_id, recorded_by, recorded_at) VALUES (gen_random_uuid(), $1, $2, '["t"]', '[]', 'CHANGE_REQUEST', $3, $4, now())`, [ref(), sub, raw, OPS]),
      ).rejects.toThrow(/Contract needs its payment terms/);
    } finally {
      await pg.query('ROLLBACK');
    }
  });

  it('C8PR-GATE-3 the apply-time gate (PR-7, §4.3 step 2): a receipt no longer matching at apply → APPLY_FAILED PAYMENT_NOT_RECORDED, nothing written, retryable once it matches', async () => {
    const t = await newTenant(pg);
    const contract_ref = ref();
    const rec = await applied('PAYMENT_RECORD', t, provisional(contract_ref));
    const receipt = await receiptOf(rec);
    const open = await approved('SUBSCRIPTION_OPEN', t, await openPayload(contract_ref, prepaidTerms()));
    // Simulate a receipt that no longer qualifies (test-only, triggers off): the gate re-reads it at apply.
    await pg.query('BEGIN');
    await pg.query(`SET LOCAL session_replication_role = replica`);
    await pg.query(`UPDATE subscription."CommercialPaymentReceipt" SET corrected_at = now(), corrected_by_change_request_id = $2 WHERE id = $1`, [receipt.id, open]);
    await pg.query('COMMIT');
    expect(await outcome(applyAs(open))).toBe('FAILED:PAYMENT_NOT_RECORDED');
    expect(await subscriptions(t)).toEqual([]);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."Contract" WHERE contract_ref = $1`, [contract_ref])).rows[0].n).toBe(0);
    await pg.query('BEGIN');
    await pg.query(`SET LOCAL session_replication_role = replica`);
    await pg.query(`UPDATE subscription."CommercialPaymentReceipt" SET corrected_at = NULL, corrected_by_change_request_id = NULL WHERE id = $1`, [receipt.id]);
    await pg.query('COMMIT');
    expect(await outcome(applyAs(open))).toBe('APPLIED');
    expect((await receiptOf(rec)).linked_by_change_request_id).toBe(open);
  });

  const STEPS: CommercialApplyFaultPoint[] = ['c8pr_after_receipt_verified', 'c8pr_after_subscription_insert', 'c8pr_after_contract_insert', 'c8pr_after_obligations_insert', 'c8pr_after_receipt_link', 'after_entitlement_write', 'before_applied'];
  for (const step of STEPS) {
    it(`C8PR-SEQ ${step}: a failure injected there rolls back the whole §4.3 transaction (no subscription, contract, obligation, entitlement, link); the receipt stays unlinked and reusable; the retry applies`, async () => {
      const t = await newTenant(pg);
      const contract_ref = ref();
      const rec = await applied('PAYMENT_RECORD', t, provisional(contract_ref));
      const open = await approved('SUBSCRIPTION_OPEN', t, await openPayload(contract_ref, prepaidTerms()));
      const receipt0 = JSON.stringify(await receiptOf(rec));
      fault = step;
      try {
        expect(await outcome(applyAs(open))).toBe('FAILED:UNEXPECTED');
      } finally {
        fault = null;
      }
      expect(await stateOf(open)).toBe('APPLY_FAILED');
      expect(await subscriptions(t)).toEqual([]);
      expect((await pg.query(`SELECT count(*)::int n FROM subscription."Contract" WHERE contract_ref = $1`, [contract_ref])).rows[0].n).toBe(0);
      expect((await pg.query(`SELECT count(*)::int n FROM entitlement."TenantEntitlement" WHERE tenant_id = $1`, [t])).rows[0].n).toBe(0);
      expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeApplication" WHERE change_request_id = $1`, [open])).rows[0].n).toBe(0);
      expect(JSON.stringify(await receiptOf(rec))).toBe(receipt0);
      expect(await outcome(applyAs(open))).toBe('APPLIED');
      expect((await receiptOf(rec)).linked_by_change_request_id).toBe(open);
    });
  }

  // ---- PR-6 duplicates, PR-8 mismatches, §4.2 / §5 --------------------------------------------------

  it('C8PR-DUP-1 PR-6: one effective record per obligation (PAYMENT_ALREADY_RECORDED); the (tenant, invoice, reference) triple is unique (PAYMENT_REFERENCE_DUPLICATE); a provisional identity twice is refused', async () => {
    const { t, contract_ref } = await prepaidOpened([{ obligation_ref: 'Y2', due_date: '2027-11-01', amount_minor: AMOUNT, description: 'Year 2' }, { obligation_ref: 'Y3', due_date: '2028-11-01', amount_minor: AMOUNT, description: 'Year 3' }]);
    expect(await refusal(create('PAYMENT_RECORD', t, linked(contract_ref, 'INITIAL')))).toBe('REFUSED:PAYMENT_ALREADY_RECORDED');
    const y2 = await applied('PAYMENT_RECORD', t, linked(contract_ref, 'Y2', { external_invoice_ref: 'INV-Y2', payment_reference: 'WIRE-Y2' }));
    expect((await receiptOf(y2)).linked_at).not.toBeNull();
    expect(await refusal(create('PAYMENT_RECORD', t, linked(contract_ref, 'Y2')))).toBe('REFUSED:PAYMENT_ALREADY_RECORDED');
    expect(await refusal(create('PAYMENT_RECORD', t, linked(contract_ref, 'Y3', { external_invoice_ref: 'INV-Y2', payment_reference: 'WIRE-Y2' })))).toBe('REFUSED:PAYMENT_REFERENCE_DUPLICATE');
    const t2 = await newTenant(pg);
    const pref = ref();
    await applied('PAYMENT_RECORD', t2, provisional(pref));
    expect(await refusal(create('PAYMENT_RECORD', t2, provisional(pref)))).toBe('REFUSED:PAYMENT_ALREADY_RECORDED');
    // DB backstop: the §4.2 partial unique index.
    expect((await pg.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'CommercialPaymentReceipt_one_unlinked_initial'`)).rows[0].indexdef).toMatch(/WHERE \(\(linked_at IS NULL\) AND \(corrected_at IS NULL\) AND \(provisional_contract_ref IS NOT NULL\)\)/);
  });

  it('C8PR-DUP-2 §4.2 CONTRACT_REF_TAKEN: a provisional ref equal to any existing contract ref (any tenant), or held by another tenant’s unlinked receipt, is refused', async () => {
    const { contract_ref } = await prepaidOpened();
    const t = await newTenant(pg);
    expect(await refusal(create('PAYMENT_RECORD', t, provisional(contract_ref)))).toBe('REFUSED:CONTRACT_REF_TAKEN');
    const t2 = await newTenant(pg);
    const held = ref();
    await applied('PAYMENT_RECORD', t2, provisional(held));
    expect(await refusal(create('PAYMENT_RECORD', t, provisional(held)))).toBe('REFUSED:CONTRACT_REF_TAKEN');
  });

  it('C8PR-MIS-1 PR-8: partial, over and other-currency payments fail closed (PAYMENT_AMOUNT_UNSUPPORTED) with a typed decision request; an unknown obligation or another tenant’s contract is PAYMENT_OBLIGATION_MISMATCH', async () => {
    const { t, contract_ref } = await prepaidOpened([{ obligation_ref: 'Y2', due_date: '2027-11-01', amount_minor: AMOUNT, description: 'Year 2' }]);
    expect(await refusal(create('PAYMENT_RECORD', t, linked(contract_ref, 'Y2', { amount_minor: AMOUNT - 1 })))).toBe('REFUSED:PAYMENT_AMOUNT_UNSUPPORTED');
    expect(await refusal(create('PAYMENT_RECORD', t, linked(contract_ref, 'Y2', { amount_minor: AMOUNT + 1 })))).toBe('REFUSED:PAYMENT_AMOUNT_UNSUPPORTED');
    expect(await refusal(create('PAYMENT_RECORD', t, linked(contract_ref, 'Y2', { currency: 'EUR' })))).toBe('REFUSED:PAYMENT_AMOUNT_UNSUPPORTED');
    expect(await refusal(create('PAYMENT_RECORD', t, provisional(ref(), { amount_minor: 1000 }, 2000)))).toBe('REFUSED:PAYMENT_AMOUNT_UNSUPPORTED');
    const ev = (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE tenant_id = $1 AND event_type = 'COMMERCIAL_PAYMENT_REFUSED' AND payload ->> 'refusal' = 'PAYMENT_AMOUNT_UNSUPPORTED' ORDER BY created_at, id`, [t])).rows.map((r) => r.payload);
    expect(ev).toHaveLength(4);
    expect(ev.map((p) => p.decision_request.type)).toEqual(['PAYMENT_AMOUNT_UNSUPPORTED', 'PAYMENT_AMOUNT_UNSUPPORTED', 'PAYMENT_AMOUNT_UNSUPPORTED', 'PAYMENT_AMOUNT_UNSUPPORTED']);
    expect(ev.map((p) => p.detail.reason)).toEqual(['partial_payment', 'overpayment', 'currency_differs', 'partial_payment']);
    expect(await refusal(create('PAYMENT_RECORD', t, linked(contract_ref, 'Y9')))).toBe('REFUSED:PAYMENT_OBLIGATION_MISMATCH');
    const other = await newTenant(pg);
    expect(await refusal(create('PAYMENT_RECORD', other, linked(contract_ref, 'Y2')))).toBe('REFUSED:PAYMENT_OBLIGATION_MISMATCH');
    // Nothing was created for any refusal.
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest" WHERE tenant_id = $1 AND state = 'DRAFT'`, [t])).rows[0].n).toBe(0);
  });

  it('C8PR-GOV-1 §5: PAYMENT_RECORD against a Stripe-owned subscription is refused (PAYMENT_RECORD_NOT_GOVERNED)', async () => {
    const t = await newTenant(pg);
    await rawSubscription(pg, t, { source: 'SELF_SERVICE', ref: `sub_c8pr_${randomUUID()}` });
    expect(await refusal(create('PAYMENT_RECORD', t, provisional(ref())))).toBe('REFUSED:PAYMENT_RECORD_NOT_GOVERNED');
  });

  // ---- cross-tenant linkage, append-only (guard trigger) -----------------------------------------------

  it('C8PR-LINK-1 the guard trigger refuses linking a receipt across tenants or products, to a contract whose ref differs, or outside an applying SUBSCRIPTION_OPEN; evidence edits and deletes are refused', async () => {
    const a = await prepaidOpened();
    const t = await newTenant(pg);
    const rec = await applied('PAYMENT_RECORD', t, provisional(ref()));
    const receipt = await receiptOf(rec);
    const obligation = (await pg.query(`SELECT id FROM subscription."ContractPaymentObligation" WHERE contract_id = $1 AND obligation_ref = 'INITIAL'`, [a.contract_id])).rows[0].id as string;
    const tryLink = async (linker: string, applying: boolean): Promise<string> => {
      await pg.query('BEGIN');
      try {
        if (applying) {
          await pg.query(`SET LOCAL session_replication_role = replica`);
          await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING' WHERE id = $1`, [linker]);
          await pg.query(`SET LOCAL session_replication_role = origin`);
        }
        await pg.query(`UPDATE subscription."CommercialPaymentReceipt" SET contract_id = $2, obligation_id = $3, linked_at = now(), linked_by_change_request_id = $4 WHERE id = $1`, [receipt.id, a.contract_id, obligation, linker]);
        return 'LINKED';
      } catch (e) {
        return (e as Error).message;
      } finally {
        await pg.query('ROLLBACK');
      }
    };
    // Another tenant's contract, linked by that tenant's (applying) open → cross-tenant: refused.
    expect(await tryLink(a.open_cr, true)).toMatch(/another tenant or product/);
    // Not by an applying SUBSCRIPTION_OPEN.
    expect(await tryLink(a.open_cr, false)).toMatch(/linked only by an applying SUBSCRIPTION_OPEN/);
    expect(await tryLink(rec, true)).toMatch(/linked only by an applying SUBSCRIPTION_OPEN/);
    const raises = async (sql: string, p: unknown[]) => {
      try {
        await pg.query(sql, p);
        return 'OK';
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(await raises(`UPDATE subscription."CommercialPaymentReceipt" SET amount_minor = 1 WHERE id = $1`, [receipt.id])).toMatch(/append-only \(its evidence and identity are immutable\)/);
    expect(await raises(`UPDATE subscription."CommercialPaymentReceipt" SET corrected_at = now(), corrected_by_change_request_id = $2 WHERE id = $1`, [receipt.id, rec])).toMatch(/superseded only by the applying CORRECT/);
    expect(await raises(`DELETE FROM subscription."CommercialPaymentReceipt" WHERE id = $1`, [receipt.id])).toMatch(/append-only \(DELETE rejected\)/);
    expect(await raises(`DELETE FROM subscription."ContractPaymentObligation" WHERE id = $1`, [obligation])).toMatch(/ContractPaymentObligation is append-only/);
    expect(await raises(`INSERT INTO subscription."CommercialPaymentReceipt" (id, change_request_id, tenant_id, product_key, entry_kind, provisional_contract_ref, provisional_obligation_ref, provisional_amount_minor, provisional_currency, external_invoice_ref, amount_minor, currency, received_on, payment_method, payment_reference, evidence_documents, origin, recorded_by, recorded_at)
       VALUES (gen_random_uuid(), $1, $2, 'sign', 'RECORD', 'CT-ROGUE-1', 'INITIAL', 1, 'USD', 'INV', 1, 'USD', '2026-10-01', 'CHEQUE', 'CHQ-1', '[]', 'MANUAL', $3, now())`, [rec, t, OPS])).toMatch(/written only by an applying PAYMENT_RECORD request/);
    // The link to a contract whose ref differs from the provisional ref (same tenant, applying open).
    const c = await newTenant(pg);
    const cref = ref();
    const recC = await applied('PAYMENT_RECORD', c, provisional(cref));
    const otherRef = ref();
    const recC2 = await applied('PAYMENT_RECORD', c, provisional(otherRef, { payment_reference: payRef() }));
    const openC = await applied('SUBSCRIPTION_OPEN', c, await openPayload(cref, prepaidTerms()));
    const cid = (await pg.query(`SELECT id FROM subscription."Contract" WHERE contract_ref = $1`, [cref])).rows[0].id as string;
    const cobl = (await pg.query(`SELECT id FROM subscription."ContractPaymentObligation" WHERE contract_id = $1 AND obligation_ref = 'INITIAL'`, [cid])).rows[0].id as string;
    await pg.query('BEGIN');
    try {
      await pg.query(`SET LOCAL session_replication_role = replica`);
      await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING' WHERE id = $1`, [openC]);
      await pg.query(`SET LOCAL session_replication_role = origin`);
      const r2 = (await receiptOf(recC2)) as { id: string };
      await expect(pg.query(`UPDATE subscription."CommercialPaymentReceipt" SET contract_id = $2, obligation_id = $3, linked_at = now(), linked_by_change_request_id = $4 WHERE id = $1`, [r2.id, cid, cobl, openC])).rejects.toThrow(/not the one its provisional ref names/);
    } finally {
      await pg.query('ROLLBACK');
    }
    expect((await receiptOf(recC)).linked_by_change_request_id).toBe(openC);
  });

  // ---- PR-9 corrections ------------------------------------------------------------------------------

  it('C8PR-COR-1 REPLACE a linked record (Finance → Owner): the original is superseded, the replacement is effective, both stay in history; the obligation stays PAID', async () => {
    const { t, contract_ref, contract_id } = await prepaidOpened([{ obligation_ref: 'Y2', due_date: '2026-10-01', amount_minor: AMOUNT, description: 'Year 2' }]);
    const y2 = await applied('PAYMENT_RECORD', t, linked(contract_ref, 'Y2', { payment_reference: 'WIRE-TYPO' }));
    const orig = await receiptOf(y2);
    const subs0 = await subscriptions(t);
    const cor = await applied('PAYMENT_RECORD', t, { operation: 'CORRECT', corrects_receipt_id: orig.id, correction: 'REPLACE', correction_reason: 'The wire reference was mistyped', ...evidence({ payment_reference: 'WIRE-FIXED' }) });
    const after = await receiptOf(y2);
    expect(after.corrected_by_change_request_id).toBe(cor);
    const repl = await receiptOf(cor);
    expect(repl).toMatchObject({ entry_kind: 'CORRECTION', corrects_receipt_id: orig.id, obligation_id: orig.obligation_id, payment_reference: 'WIRE-FIXED', corrected_at: null });
    const view = await new ContractPaymentReadService(prisma, () => T0).contractPayments(contract_id);
    expect(view?.obligations.find((o) => o.obligation_ref === 'Y2')).toMatchObject({ status: 'PAID', effective_receipt_id: repl.id });
    expect(view?.records.filter((r) => r.obligation_ref === 'Y2').map((r) => [r.entry_kind, r.effective])).toEqual([['RECORD', false], ['CORRECTION', true]]);
    // A correction never changes obligations or subscription state (PR-9).
    expect(await subscriptions(t)).toEqual(subs0);
    // An already-corrected record cannot be corrected again.
    expect(await refusal(create('PAYMENT_RECORD', t, { operation: 'CORRECT', corrects_receipt_id: orig.id, correction: 'VOID', correction_reason: 'again' }))).toBe('REFUSED:PAYMENT_CORRECTION_TARGET_INVALID');
    const ev = (await pg.query(`SELECT event_type FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1`, [cor])).rows.map((r) => r.event_type);
    expect(ev).toContain('COMMERCIAL_PAYMENT_CORRECTED');
  });

  it('C8PR-COR-2 VOID a linked non-INITIAL record: the obligation is no longer PAID (PAST_DUE here); a consumed INITIAL can be neither voided nor replaced into a mismatch (PAYMENT_OBLIGATION_MISMATCH)', async () => {
    const { t, contract_ref, contract_id, receipt_cr } = await prepaidOpened([{ obligation_ref: 'Y2', due_date: '2026-10-01', amount_minor: AMOUNT, description: 'Year 2' }]);
    const y2 = await applied('PAYMENT_RECORD', t, linked(contract_ref, 'Y2'));
    await applied('PAYMENT_RECORD', t, { operation: 'CORRECT', corrects_receipt_id: (await receiptOf(y2)).id, correction: 'VOID', correction_reason: 'The wire bounced' });
    const view = await new ContractPaymentReadService(prisma, () => T0).contractPayments(contract_id);
    expect(view?.obligations.find((o) => o.obligation_ref === 'Y2')?.status).toBe('PAST_DUE');
    expect(view?.payment_overdue).toBe(true);
    const initial = (await receiptOf(receipt_cr)).id as string;
    expect(await refusal(create('PAYMENT_RECORD', t, { operation: 'CORRECT', corrects_receipt_id: initial, correction: 'VOID', correction_reason: 'x' }))).toBe('REFUSED:PAYMENT_OBLIGATION_MISMATCH');
    expect(await refusal(create('PAYMENT_RECORD', t, { operation: 'CORRECT', corrects_receipt_id: initial, correction: 'REPLACE', correction_reason: 'x', ...evidence({ amount_minor: AMOUNT - 100 }) }))).toBe('REFUSED:PAYMENT_OBLIGATION_MISMATCH');
    // A same-amount replacement of the consumed INITIAL is allowed (corrected evidence, still matching).
    const fix = await applied('PAYMENT_RECORD', t, { operation: 'CORRECT', corrects_receipt_id: initial, correction: 'REPLACE', correction_reason: 'Received date corrected', ...evidence({ received_on: '2026-10-19' }) });
    expect((await receiptOf(fix)).contract_id).toBe((await receiptOf(receipt_cr)).contract_id);
  });

  it('C8PR-COR-3 an unlinked INITIAL is never expired: it is listed (C6) and alerted (D3) until a CORRECT stating that no contract will follow neutralizes it', async () => {
    const t = await newTenant(pg);
    const pref = ref();
    const rec = await applied('PAYMENT_RECORD', t, provisional(pref));
    const receipt = await receiptOf(rec);
    const report = await new BillingFinanceReportService(prisma, h.billing).reconciliationReport({ tenant_id: t, as_of: T0 });
    expect(report.unlinked_receipts.map((u) => [u.receipt_id, u.provisional_contract_ref])).toEqual([[receipt.id, pref]]);
    expect(report.counts.unlinked_receipts).toBe(1);
    expect(report.status).toBe('EXCEPTIONS');
    expect(JSON.stringify(report.unlinked_receipts)).not.toMatch(/amount/);
    const alerts = new CommercialAlertService(prisma);
    await alerts.scan(new Date(T0.getTime() + 90 * 86_400_000));
    const open = (await pg.query(`SELECT status, family, subject_kind, tenant_id::text t, evidence FROM subscription."CommercialOperationalAlert" WHERE alert_type = 'PAYMENT_RECEIPT_UNLINKED' AND subject_id = $1`, [receipt.id])).rows;
    expect(open).toEqual([{ status: 'OPEN', family: 'BILLING', subject_kind: 'payment_receipt', t, evidence: expect.objectContaining({ receipt_id: receipt.id, provisional_contract_ref: pref }) }]);
    expect(JSON.stringify(open[0].evidence)).not.toMatch(/amount/);
    // Still unlinked 90 days later (no automatic expiry).
    expect((await receiptOf(rec)).corrected_at).toBeNull();
    expect(await refusal(create('PAYMENT_RECORD', t, { operation: 'CORRECT', corrects_receipt_id: receipt.id, correction: 'VOID', correction_reason: 'Deal lost' }))).toBe('REFUSED:PAYMENT_CORRECTION_TARGET_INVALID');
    await applied('PAYMENT_RECORD', t, { operation: 'CORRECT', corrects_receipt_id: receipt.id, correction: 'VOID', correction_reason: 'Deal lost; funds returned outside Aramo', no_contract_will_follow: true });
    expect((await new BillingFinanceReportService(prisma, h.billing).reconciliationReport({ tenant_id: t, as_of: T0 })).unlinked_receipts).toEqual([]);
    await alerts.scan(new Date(T0.getTime() + 91 * 86_400_000));
    expect((await pg.query(`SELECT status FROM subscription."CommercialOperationalAlert" WHERE alert_type = 'PAYMENT_RECEIPT_UNLINKED' AND subject_id = $1`, [receipt.id])).rows[0].status).toBe('RESOLVED');
    // Neutralized: the ref can be provisioned again.
    await applied('PAYMENT_RECORD', t, provisional(pref));
  });

  // ---- PR-10 via the read model; TenantSubscription.status never written ---------------------------------

  it('C8PR-STAT-1 PR-10 through the read model, in the contract timezone: due 2026-10-25, g = 0 is DUE on the 25th and PAST_DUE from the 26th (New York), NOT_DUE before; grace 2 keeps it DUE through the 27th; TenantSubscription.status is never written', async () => {
    const { t, contract_id } = await prepaidOpened([{ obligation_ref: 'Q4', due_date: '2026-10-25', amount_minor: 50_000, description: 'Q4 fee' }]);
    const subs0 = await subscriptions(t);
    const at = async (iso: string) => {
      const v = await new ContractPaymentReadService(prisma, () => new Date(iso)).contractPayments(contract_id);
      return [v?.as_of_date, v?.obligations.find((o) => o.obligation_ref === 'Q4')?.status, v?.obligations.find((o) => o.obligation_ref === 'INITIAL')?.status];
    };
    expect(await at('2026-10-25T03:59:00Z')).toEqual(['2026-10-24', 'NOT_DUE', 'PAID']);
    expect(await at('2026-10-25T04:00:00Z')).toEqual(['2026-10-25', 'DUE', 'PAID']);
    expect(await at('2026-10-26T03:59:59Z')).toEqual(['2026-10-25', 'DUE', 'PAID']);
    expect(await at('2026-10-26T04:00:00Z')).toEqual(['2026-10-26', 'PAST_DUE', 'PAID']);
    expect(await subscriptions(t)).toEqual(subs0);
    const g = await prepaidOpened([{ obligation_ref: 'Q4', due_date: '2026-10-25', amount_minor: 50_000, description: 'Q4 fee' }], { grace_days: 2 });
    const v27 = await new ContractPaymentReadService(prisma, () => new Date('2026-10-28T03:59:00Z')).contractPayments(g.contract_id);
    expect(v27?.obligations.find((o) => o.obligation_ref === 'Q4')?.status).toBe('DUE');
    expect(v27?.payment_terms).toMatchObject({ grace_days: 2, effective_grace_days: 2 });
    const v28 = await new ContractPaymentReadService(prisma, () => new Date('2026-10-28T04:00:00Z')).contractPayments(g.contract_id);
    expect(v28?.obligations.find((o) => o.obligation_ref === 'Q4')?.status).toBe('PAST_DUE');
    expect(v28).toMatchObject({ payment_due: true, payment_overdue: true });
    // Payment status is not access status: the subscription row is untouched and still ACTIVE.
    expect((await pg.query(`SELECT status FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL`, [g.t])).rows[0].status).toBe('ACTIVE');
  });

  it('C8PR-AMEND-1 PR-1 amendment (v1 additions only): a SUBSCRIPTION_CHANGE adds an obligation; changing a recorded obligation or the contract terms fails closed (PAYMENT_TERMS_CHANGE_UNDEFINED)', async () => {
    const { t, contract_id } = await prepaidOpened();
    const sub = (await pg.query(`SELECT tenant_subscription_id::text s FROM subscription."Contract" WHERE id = $1`, [contract_id])).rows[0].s as string;
    const v = await publishedVersion(pg, ENTERPRISE);
    const amend = (terms: Record<string, unknown>) => ({ subscription_id: sub, plan_key: ENTERPRISE, plan_version_id: v, contract_amendment: { contract_id, summary: 'Year 2 added', documents: [], payment_terms: terms } });
    await applied('SUBSCRIPTION_CHANGE', t, amend(prepaidTerms(AMOUNT, [{ obligation_ref: 'Y2', due_date: '2027-11-01', amount_minor: AMOUNT, description: 'Year 2' }])));
    expect((await pg.query(`SELECT obligation_ref FROM subscription."ContractPaymentObligation" WHERE contract_id = $1 ORDER BY obligation_ref`, [contract_id])).rows.map((r) => r.obligation_ref)).toEqual(['INITIAL', 'Y2']);
    const bad = await approved('SUBSCRIPTION_CHANGE', t, amend(prepaidTerms(AMOUNT + 5, [{ obligation_ref: 'Y2', due_date: '2027-11-01', amount_minor: AMOUNT, description: 'Year 2' }])));
    expect(await outcome(applyAs(bad))).toBe('FAILED:PAYMENT_TERMS_CHANGE_UNDEFINED');
  });

  // ---- Q14 concurrency (K-4) ------------------------------------------------------------------------------

  it('C8PR-Q14-1 one open request per tenant × product, without exception: concurrent PAYMENT_RECORD creates → exactly one; an open PAYMENT_RECORD blocks the SUBSCRIPTION_OPEN until it is applied', async () => {
    const t = await newTenant(pg);
    const pref = ref();
    const results = await Promise.allSettled([0, 1, 2].map(() => create('PAYMENT_RECORD', t, provisional(pref))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => ((r as PromiseRejectedResult).reason as CommercialChangeRequestError).code)).toEqual(['OPEN_REQUEST_EXISTS', 'OPEN_REQUEST_EXISTS']);
    const id = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<string>).value;
    expect(await refusal(create('SUBSCRIPTION_OPEN', t, await openPayload(pref, prepaidTerms())))).toBe('OPEN_REQUEST_EXISTS');
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), id, A6_CTX);
    await h.changeRequests.approve(as(FA1, 'finance_admin'), id, { step_index: 0 }, A6_CTX);
    expect(await refusal(create('SUBSCRIPTION_OPEN', t, await openPayload(pref, prepaidTerms())))).toBe('OPEN_REQUEST_EXISTS');
    await applyAs(id);
    const open = await create('SUBSCRIPTION_OPEN', t, await openPayload(pref, prepaidTerms()));
    expect(await stateOf(open)).toBe('DRAFT');
  });

  it('C8PR-IDEM-1 PR-4 idempotent: a replayed apply returns the same record and writes nothing', async () => {
    const t = await newTenant(pg);
    const id = await approved('PAYMENT_RECORD', t, provisional(ref()));
    const first = await applyAs(id);
    const again = await applyAs(id);
    expect(again.replayed).toBe(true);
    expect(again.application?.id).toBe(first.application?.id);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialPaymentReceipt" WHERE change_request_id = $1`, [id])).rows[0].n).toBe(1);
    expect(first.application).toMatchObject({ action_type: 'PAYMENT_RECORD', subscription_id: null, capabilities: [], capabilities_revoked: [] });
  });
});
