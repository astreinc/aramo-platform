import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommercialApplyFailedError } from '../lib/commercial/commercial-apply.service.js';
import { type CommercialActionType, CommercialPayloadError } from '../lib/commercial/commercial-change-request.js';
import { ContractRepository } from '../lib/commercial/commercial-contract.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, INCLUDED, a6Harness, as, newTenant, publishedVersion, rawSubscription, type A6Harness } from './support/ccp-a6.js';

// CCP-B4 (PBD §5.3 row B4 mandatory tests: MP-A2 N-3(a)–(d) evidence and evidence attachments)
// on real Postgres 17 with identity + entitlement + metering + EVERY subscription migration
// (whole-file applier). Test IDs are cited by doc/ccp/slices/CCP-B4-acceptance.md.

const T0 = new Date('2026-10-25T12:00:00.000Z');
const REPO_ROOT = resolve(__dirname, '../../../..');
const SHA = (c: string): string => c.repeat(64).slice(0, 64);
const DOC_MSA = { name: 'Master services agreement.pdf', sha256: SHA('9f2c61d0a84b1e'), byte_size: 482113, media_type: 'application/pdf' };
const DOC_OF = { name: 'Order form OF-7781.pdf', sha256: SHA('51ad09fe37e07c') };
const DOC_AM = { name: 'Amendment 1.pdf', sha256: SHA('c3e04b77119a42') };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-B4 enterprise contracts (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: A6Harness;
  let contracts: ContractRepository;
  let OPS: string;
  let FA: string;
  let keyN = 0;
  let refN = 0;
  const key = () => `b4-key-${String(++keyN).padStart(6, '0')}`;
  const ref = () => `CT-2026-${String(100 + ++refN)}`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = a6Harness(prisma, () => T0);
    contracts = new ContractRepository(prisma);
    OPS = await addOperator(pg, ['commercial_ops']);
    await pg.query(`UPDATE identity."User" SET display_name = 'Tomás Silva' WHERE id = $1`, [OPS]);
    FA = await addOperator(pg, ['finance_admin']);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  async function create(action_type: CommercialActionType, tenant_id: string, payload: Record<string, unknown>, kind: 'NORMAL' | 'MIGRATION' = 'NORMAL'): Promise<string> {
    const r = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type, kind, tenant_id, product_key: 'sign', payload, reason: 'enterprise contract', idempotency_key: key() }, A6_CTX);
    return r.request.id;
  }
  async function approved(action_type: CommercialActionType, tenant_id: string, payload: Record<string, unknown>, kind: 'NORMAL' | 'MIGRATION' = 'NORMAL'): Promise<string> {
    const id = await create(action_type, tenant_id, payload, kind);
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), id, A6_CTX);
    const a = await h.changeRequests.approve(as(FA, 'finance_admin'), id, { step_index: 0 }, A6_CTX);
    expect(a.request.state).toBe('APPROVED');
    return id;
  }
  const applyAs = (id: string) => h.apply.apply(as(OPS, 'commercial_ops'), id, A6_CTX);
  async function outcome(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return 'APPLIED';
    } catch (e) {
      if (e instanceof CommercialApplyFailedError) return `FAILED:${e.code}`;
      throw e;
    }
  }
  async function raises(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await pg.query(sql, params);
    } catch (e) {
      try {
        await pg.query('ROLLBACK');
      } catch {
        /* not in a transaction */
      }
      return (e as Error).message;
    }
    throw new Error(`expected the statement to raise: ${sql}`);
  }
  const recordBlock = (contract_ref = ref(), extra: Record<string, unknown> = {}) => ({
    contract_ref,
    terms: ['Sign Enterprise at a negotiated monthly price', 'Allowance of 25,000 envelopes per month', 'Invoiced monthly, net 45'],
    documents: [DOC_MSA, DOC_OF],
    evidence_ref: 'Order form OF-7781',
    ...extra,
  });
  /** A tenant with a contract recorded with its governed open (SUBSCRIPTION_OPEN + contract). */
  async function contracted(kind: 'NORMAL' | 'MIGRATION' = 'NORMAL'): Promise<{ t: string; sub: string; contract_id: string; contract_ref: string; version: string }> {
    const t = await newTenant(pg);
    const version = await publishedVersion(pg, INCLUDED);
    const contract_ref = ref();
    const id = await approved('SUBSCRIPTION_OPEN', t, { plan_key: INCLUDED, plan_version_id: version, replaces_subscription_id: null, contract: recordBlock(contract_ref) }, kind);
    const out = await applyAs(id);
    const sub = out.application.subscription_id as string;
    const c = (await pg.query(`SELECT id FROM subscription."Contract" WHERE tenant_subscription_id = $1`, [sub])).rows[0];
    return { t, sub, contract_id: c.id as string, contract_ref, version };
  }
  const contractRow = async (id: string) => (await pg.query(`SELECT row_to_json(c)::text j FROM subscription."Contract" c WHERE id = $1`, [id])).rows[0]?.j as string;

  // ---- N-3(a)–(d) ------------------------------------------------------------------------

  it('B4-N3-a both tables live in the subscription schema (and nowhere else)', async () => {
    const r = await pg.query(`SELECT table_schema, table_name FROM information_schema.tables WHERE table_name IN ('Contract', 'ContractAmendment') ORDER BY table_name`);
    expect(r.rows).toEqual([
      { table_schema: 'subscription', table_name: 'Contract' },
      { table_schema: 'subscription', table_name: 'ContractAmendment' },
    ]);
  });

  it('B4-N3-b Contract references the TenantSubscription it governs by FK (NOT NULL, RESTRICT); an amendment references its Contract', async () => {
    const fks = await pg.query(
      `SELECT conname, conrelid::regclass::text AS tbl, confrelid::regclass::text AS ref, confdeltype
         FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text IN ('subscription."Contract"', 'subscription."ContractAmendment"') ORDER BY conname`,
    );
    expect(fks.rows).toEqual([
      { conname: 'ContractAmendment_change_request_id_fkey', tbl: 'subscription."ContractAmendment"', ref: 'subscription."CommercialChangeRequest"', confdeltype: 'r' },
      { conname: 'ContractAmendment_contract_id_fkey', tbl: 'subscription."ContractAmendment"', ref: 'subscription."Contract"', confdeltype: 'r' },
      { conname: 'Contract_recorded_by_change_request_id_fkey', tbl: 'subscription."Contract"', ref: 'subscription."CommercialChangeRequest"', confdeltype: 'r' },
      { conname: 'Contract_tenant_subscription_id_fkey', tbl: 'subscription."Contract"', ref: 'subscription."TenantSubscription"', confdeltype: 'r' },
    ]);
    const nn = await pg.query(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'subscription' AND table_name = 'Contract' AND column_name = 'tenant_subscription_id'`);
    expect(nn.rows[0].is_nullable).toBe('NO');
    // The subscription row a contract references can never be deleted out from under it.
    const { sub } = await contracted();
    expect(await raises(`DELETE FROM subscription."TenantSubscription" WHERE id = $1`, [sub])).toMatch(/Contract_tenant_subscription_id_fkey|violates foreign key/);
  });

  it('B4-N3-c no contract column answers "which plan, allowance or subscription": no plan/version/product/allowance/commitment column; the allowance resolves from the subscription only; no resolver reads the contract tables', async () => {
    const cols = (await pg.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'subscription' AND table_name IN ('Contract', 'ContractAmendment') ORDER BY table_name, ordinal_position`)).rows.map((r) => `${r.table_name}.${r.column_name}`);
    expect(cols).toEqual([
      'Contract.id', 'Contract.contract_ref', 'Contract.tenant_subscription_id', 'Contract.terms', 'Contract.evidence_documents', 'Contract.evidence_ref', 'Contract.provenance', 'Contract.recorded_by_change_request_id', 'Contract.recorded_by', 'Contract.recorded_at',
      'ContractAmendment.id', 'ContractAmendment.contract_id', 'ContractAmendment.sequence', 'ContractAmendment.kind', 'ContractAmendment.summary', 'ContractAmendment.terms', 'ContractAmendment.evidence_documents', 'ContractAmendment.evidence_ref', 'ContractAmendment.change_request_id', 'ContractAmendment.recorded_by', 'ContractAmendment.recorded_at',
    ]);
    for (const c of cols) expect(c).not.toMatch(/plan|version|product|allowance|commitment|quota|limit|tenant_id|capabilit/);
    // The terms text says 25,000 envelopes; the allowance is the pinned version's, unchanged.
    const t = await newTenant(pg);
    const version = await publishedVersion(pg, INCLUDED);
    const before = await approved('SUBSCRIPTION_OPEN', t, { plan_key: INCLUDED, plan_version_id: version, replaces_subscription_id: null });
    const sub = (await applyAs(before)).application.subscription_id as string;
    const status0 = JSON.stringify(await h.allowance.getStatus(t, 'sign', 'sign.envelopes', T0));
    const rec = await approved('SUBSCRIPTION_CHANGE', t, { subscription_id: sub, plan_key: INCLUDED, plan_version_id: version, contract: recordBlock(ref(), { terms: ['Allowance of 999,999 envelopes per month'] }) });
    await applyAs(rec);
    expect(JSON.stringify(await h.allowance.getStatus(t, 'sign', 'sign.envelopes', T0))).toBe(status0);
    // Static scan: outside the contract module, the A6 apply wiring and the read routes, no
    // source in subscription / entitlement / metering / sign-service reads the contract tables.
    const allowed = new Set([
      'libs/subscription/src/lib/commercial/commercial-contract.ts',
      'libs/subscription/src/lib/commercial/commercial-contract.repository.ts',
      'libs/subscription/src/lib/commercial/commercial-apply.service.ts',
      'libs/subscription/src/lib/commercial/commercial-change-request.ts',
      'libs/subscription/src/lib/subscription.module.ts',
      'libs/subscription/src/lib/billing/governed-subscription.ts',
      'libs/subscription/src/index.ts',
    ]);
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) {
          if (n !== 'tests' && n !== 'generated' && n !== 'node_modules') walk(p);
        } else if (n.endsWith('.ts')) {
          const rel = p.slice(REPO_ROOT.length + 1);
          if (!allowed.has(rel) && /"Contract"|"ContractAmendment"|\.contract\.|\.contractAmendment\.|ContractRepository|commercial-contract/.test(readFileSync(p, 'utf8'))) hits.push(rel);
        }
      }
    };
    for (const d of ['libs/subscription/src', 'libs/entitlement/src', 'libs/metering/src', 'apps/sign-service/src']) walk(resolve(REPO_ROOT, d));
    expect(hits).toEqual([]);
  });

  it('B4-N3-d no independent open/closed state and no usage ledger: no status/ended/usage column; Active / Ended is derived from the subscription row; the contract row is never written again', async () => {
    const stateCols = await pg.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'subscription' AND table_name IN ('Contract', 'ContractAmendment') AND column_name ~ '(status|state|active|ended|closed|open|usage|used|remaining|consum|reserv|period)'`,
    );
    expect(stateCols.rows).toEqual([]);
    // No FK from any usage table to the contract tables, and none from them to a usage table.
    const usageFks = await pg.query(
      `SELECT conname FROM pg_constraint WHERE contype = 'f' AND (confrelid::regclass::text IN ('subscription."Contract"', 'subscription."ContractAmendment"') AND conrelid::regclass::text NOT IN ('subscription."ContractAmendment"'))`,
    );
    expect(usageFks.rows).toEqual([]);
    const { t, sub, contract_id } = await contracted();
    expect((await contracts.get(contract_id))?.status).toBe('ACTIVE');
    const row0 = await contractRow(contract_id);
    await pg.query(
      `INSERT INTO subscription."AllowanceUsage" (id, tenant_id, allowance_key, send_key, period_start, state, reserved_until, finalized_at) VALUES (gen_random_uuid(), $1, 'sign.envelopes', 'b4-env-1', now(), 'CONSUMED', now(), now())`,
      [t],
    );
    const usage = async () => (await pg.query(`SELECT row_to_json(u)::text j FROM subscription."AllowanceUsage" u WHERE tenant_id = $1 ORDER BY id`, [t])).rows;
    const usage0 = await usage();
    const end = await approved('SUBSCRIPTION_END', t, { subscription_id: sub, contract_end: { contract_id, summary: 'Not renewed', documents: [], evidence_ref: 'Non-renewal notice' } });
    await applyAs(end);
    const d = await contracts.get(contract_id);
    expect(d?.status).toBe('ENDED');
    expect(d?.subscription.ended_at).not.toBeNull();
    expect(await contractRow(contract_id)).toBe(row0); // the end wrote no contract column
    expect(await usage()).toEqual(usage0); // usage stays in AllowanceUsage, untouched
    expect(await raises(`UPDATE subscription."Contract" SET evidence_ref = 'x' WHERE id = $1`, [contract_id])).toMatch(/Contract is append-only \(UPDATE rejected\)/);
    expect(await raises(`DELETE FROM subscription."Contract" WHERE id = $1`, [contract_id])).toMatch(/Contract is append-only \(DELETE rejected\)/);
    expect(await raises(`UPDATE subscription."ContractAmendment" SET summary = 'x' WHERE contract_id = $1`, [contract_id])).toMatch(/ContractAmendment is append-only \(UPDATE rejected\)/);
    expect(await raises(`DELETE FROM subscription."ContractAmendment" WHERE contract_id = $1`, [contract_id])).toMatch(/ContractAmendment is append-only \(DELETE rejected\)/);
  });

  // ---- governed lifecycle ----------------------------------------------------------------

  it('B4-REC-1 a contract is recorded with the governed open, in the A6 transaction, with its documents, provenance and audit event', async () => {
    const { contract_id, contract_ref, version } = await contracted();
    const d = await contracts.get(contract_id);
    expect(d).toMatchObject({
      contract_ref,
      status: 'ACTIVE',
      provenance: 'CHANGE_REQUEST',
      product_key: 'sign',
      subscription: { source: 'MANUAL', plan: { key: INCLUDED }, plan_version: { id: version, status: 'PUBLISHED' } },
      terms: ['Sign Enterprise at a negotiated monthly price', 'Allowance of 25,000 envelopes per month', 'Invoiced monthly, net 45'],
      evidence_ref: 'Order form OF-7781',
      recorded_by: { user_id: OPS, display_name: 'Tomás Silva' },
      invoicing: { enabled: false, reason: 'enterprise_invoicing_choice_pending' },
      amendments: [],
    });
    expect(d?.documents.map((x) => [x.name, x.sha256, x.byte_size ?? null, x.amendment_sequence, x.recorded_by.display_name])).toEqual([
      [DOC_MSA.name, DOC_MSA.sha256, DOC_MSA.byte_size, null, 'Tomás Silva'],
      [DOC_OF.name, DOC_OF.sha256, null, null, 'Tomás Silva'],
    ]);
    const ev = await pg.query(`SELECT event_type FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [d?.recorded_by_change_request_id]);
    expect(ev.rows.map((r) => r.event_type)).toContain('COMMERCIAL_CONTRACT_RECORDED');
    expect((await contracts.list()).map((c) => c.id)).toContain(contract_id);
  });

  it('B4-MIG-1 provenance follows the recording request kind: a NORMAL request cannot record a MIGRATION contract (and the A3 create path admits no MIGRATION kind, TD-B4-7)', async () => {
    const t = await newTenant(pg);
    await expect(create('SUBSCRIPTION_OPEN', t, { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null, contract: recordBlock() }, 'MIGRATION')).rejects.toThrow(/kind MIGRATION is not created through this path/);
    const sub = (await applyAs(await approved('SUBSCRIPTION_OPEN', t, { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null }))).application.subscription_id as string;
    const id = await approved('SUBSCRIPTION_CHANGE', t, { subscription_id: sub, plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), contract: recordBlock() });
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1, updated_at = now() WHERE id = $1`, [id]);
    expect(await raises(`INSERT INTO subscription."Contract" (id, contract_ref, tenant_subscription_id, terms, evidence_documents, provenance, recorded_by_change_request_id, recorded_by, recorded_at) VALUES (gen_random_uuid(), '${ref()}', $1, '["t"]', '[]', 'MIGRATION', $2, $3, now())`, [sub, id, OPS])).toMatch(
      /provenance must follow the request kind/,
    );
    // The same request records it with provenance CHANGE_REQUEST through the apply.
    await applyAs(id);
    const c = (await pg.query(`SELECT provenance FROM subscription."Contract" WHERE tenant_subscription_id = $1`, [sub])).rows[0];
    expect(c.provenance).toBe('CHANGE_REQUEST');
  });

  it('B4-AMD-1 a terms-only amendment is a SUBSCRIPTION_CHANGE on the pinned version: the subscription row is not written, the amendment and its documents are recorded; without a contract block the same version is still NO_CHANGE', async () => {
    const { t, sub, contract_id, version } = await contracted();
    const subRow = async () => (await pg.query(`SELECT row_to_json(s)::text j FROM subscription."TenantSubscription" s WHERE id = $1`, [sub])).rows[0].j;
    const pins = async () => (await pg.query(`SELECT count(*)::int n FROM subscription."SubscriptionVersionPinEvent" WHERE tenant_id = $1`, [t])).rows[0].n;
    const sub0 = await subRow();
    const pins0 = await pins();
    const id = await approved('SUBSCRIPTION_CHANGE', t, {
      subscription_id: sub,
      plan_key: INCLUDED,
      plan_version_id: version,
      contract_amendment: { contract_id, summary: 'Allowance raised from 20,000 to 25,000 envelopes per month.', terms: ['Allowance of 25,000 envelopes per month', 'Invoiced monthly, net 45'], documents: [DOC_AM], evidence_ref: 'Amendment 1' },
    });
    const out = await applyAs(id);
    expect(out.request.state).toBe('APPLIED');
    expect(out.application).toMatchObject({ from_plan_version_id: version, to_plan_version_id: version });
    expect(await subRow()).toBe(sub0);
    expect(await pins()).toBe(pins0);
    const d = await contracts.get(contract_id);
    expect(d?.amendments).toMatchObject([{ sequence: 1, kind: 'AMENDMENT', summary: 'Allowance raised from 20,000 to 25,000 envelopes per month.', change_request_id: id }]);
    expect(d?.terms).toEqual(['Allowance of 25,000 envelopes per month', 'Invoiced monthly, net 45']);
    expect(d?.recorded_terms).toHaveLength(3);
    expect(d?.documents.map((x) => [x.name, x.amendment_sequence])).toEqual([
      [DOC_MSA.name, null],
      [DOC_OF.name, null],
      [DOC_AM.name, 1],
    ]);
    const ev = await pg.query(`SELECT event_type FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [id]);
    expect(ev.rows.map((r) => r.event_type)).toContain('COMMERCIAL_CONTRACT_AMENDED');
    expect(ev.rows.map((r) => r.event_type)).not.toContain('COMMERCIAL_SUBSCRIPTION_CHANGED');
    // A second amendment takes sequence 2 (gap-free).
    await applyAs(await approved('SUBSCRIPTION_CHANGE', t, { subscription_id: sub, plan_key: INCLUDED, plan_version_id: version, contract_amendment: { contract_id, summary: 'Portal added', documents: [] } }));
    expect((await contracts.get(contract_id))?.amendments.map((a) => a.sequence)).toEqual([1, 2]);
    // The A6 rule is unchanged without a contract block.
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_CHANGE', t, { subscription_id: sub, plan_key: INCLUDED, plan_version_id: version })))).toBe('FAILED:NO_CHANGE');
  });

  it('B4-END-1 ending a contract-linked row needs the END to name the contract; otherwise APPLY_FAILED CONTRACT_MISMATCH and nothing is written; an open may not replace a contract row', async () => {
    // One tenant per failing case: an APPLY_FAILED request keeps the Q14 slot (TD-A6-5).
    const subOpen = async (sub: string) => (await pg.query(`SELECT ended_at FROM subscription."TenantSubscription" WHERE id = $1`, [sub])).rows[0].ended_at;
    const c1 = await contracted();
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_END', c1.t, { subscription_id: c1.sub })))).toBe('FAILED:CONTRACT_MISMATCH');
    expect(await subOpen(c1.sub)).toBeNull();
    const c2 = await contracted();
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_END', c2.t, { subscription_id: c2.sub, contract_end: { contract_id: c1.contract_id, documents: [] } })))).toBe('FAILED:CONTRACT_MISMATCH');
    expect(await subOpen(c2.sub)).toBeNull();
    const c3 = await contracted();
    const replace = await approved('SUBSCRIPTION_OPEN', c3.t, { plan_key: INCLUDED, plan_version_id: c3.version, replaces_subscription_id: c3.sub });
    expect(await outcome(applyAs(replace))).toBe('FAILED:CONTRACT_MISMATCH');
    expect(await subOpen(c3.sub)).toBeNull();
    const { t, sub, contract_id } = await contracted();
    const end = await approved('SUBSCRIPTION_END', t, { subscription_id: sub, contract_end: { contract_id, documents: [DOC_AM] } });
    await applyAs(end);
    const d = await contracts.get(contract_id);
    expect(d?.status).toBe('ENDED');
    expect(d?.amendments).toMatchObject([{ sequence: 1, kind: 'END', summary: 'Contract ended', change_request_id: end, terms: null }]);
    expect((await contracts.list({ status: 'ENDED' })).map((c) => c.id)).toContain(contract_id);
    expect((await contracts.list({ status: 'ACTIVE' })).map((c) => c.id)).not.toContain(contract_id);
    // Ended: the row is the state; a further END is stale.
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_END', t, { subscription_id: sub, contract_end: { contract_id, documents: [] } })))).toBe('FAILED:TARGET_STALE');
  });

  it('B4-REC-2 a second contract on the same row, or a taken contract_ref, fails the apply (rolled back)', async () => {
    const { t, sub, contract_ref, version } = await contracted();
    expect(await outcome(applyAs(await approved('SUBSCRIPTION_CHANGE', t, { subscription_id: sub, plan_key: INCLUDED, plan_version_id: version, contract: recordBlock() })))).toBe('FAILED:CONTRACT_ALREADY_RECORDED');
    const t2 = await newTenant(pg);
    const dup = await approved('SUBSCRIPTION_OPEN', t2, { plan_key: INCLUDED, plan_version_id: version, replaces_subscription_id: null, contract: recordBlock(contract_ref) });
    expect(await outcome(applyAs(dup))).toBe('FAILED:CONTRACT_REF_TAKEN');
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."TenantSubscription" WHERE tenant_id = $1`, [t2])).rows[0].n).toBe(0);
  });

  // ---- no direct mutation; definition (b) ⊆ (a) -------------------------------------------

  it('B4-GUARD-1 no contract row can be written except by an applying request of the matching action and tenant, and only on an open MANUAL BASE row with no provider link', async () => {
    const { t, sub, contract_id, version } = await contracted();
    const insert = (cr: string, s: string) =>
      pg.query(
        `INSERT INTO subscription."Contract" (id, contract_ref, tenant_subscription_id, terms, evidence_documents, provenance, recorded_by_change_request_id, recorded_by, recorded_at)
         VALUES (gen_random_uuid(), $1, $2, '["t"]', '[]', 'CHANGE_REQUEST', $3, $4, now())`,
        [ref(), s, cr, OPS],
      );
    const draft = await create('SUBSCRIPTION_CHANGE', t, { subscription_id: sub, plan_key: INCLUDED, plan_version_id: version, contract: recordBlock() });
    await expect(insert(draft, sub)).rejects.toThrow(/Contract is recorded only by an applying SUBSCRIPTION_OPEN or SUBSCRIPTION_CHANGE request/);
    await expect(
      pg.query(
        `INSERT INTO subscription."ContractAmendment" (id, contract_id, sequence, kind, summary, evidence_documents, change_request_id, recorded_by, recorded_at) VALUES (gen_random_uuid(), $1, 1, 'AMENDMENT', 's', '[]', $2, $3, now())`,
        [contract_id, draft, OPS],
      ),
    ).rejects.toThrow(/ContractAmendment is recorded only by an applying change request/);
    // A request legitimately in APPLYING (inside one transaction) still cannot attach a
    // contract to a SELF_SERVICE row, nor to another tenant's row.
    const t2 = await newTenant(pg);
    const selfRow = await rawSubscription(pg, t2, { source: 'SELF_SERVICE', ref: `sub_b4_${t2.slice(0, 8)}` });
    const id = await approved('SUBSCRIPTION_CHANGE', t2, { subscription_id: selfRow, plan_key: INCLUDED, plan_version_id: version, contract: recordBlock() });
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1, updated_at = now() WHERE id = $1`, [id]);
    expect(await raises(`INSERT INTO subscription."Contract" (id, contract_ref, tenant_subscription_id, terms, evidence_documents, provenance, recorded_by_change_request_id, recorded_by, recorded_at) VALUES (gen_random_uuid(), '${ref()}', $1, '["t"]', '[]', 'CHANGE_REQUEST', $2, $3, now())`, [selfRow, id, OPS])).toMatch(
      /only an open MANUAL BASE subscription with no provider link/,
    );
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1, updated_at = now() WHERE id = $1`, [id]);
    expect(await raises(`INSERT INTO subscription."Contract" (id, contract_ref, tenant_subscription_id, terms, evidence_documents, provenance, recorded_by_change_request_id, recorded_by, recorded_at) VALUES (gen_random_uuid(), '${ref()}', $1, '["t"]', '[]', 'CHANGE_REQUEST', $2, $3, now())`, [sub, id, OPS])).toMatch(
      /does not belong to the request tenant and product/,
    );
    // The apply itself refuses the SELF_SERVICE row before any contract write (G1).
    expect(await outcome(applyAs(id))).toBe('FAILED:STRIPE_OWNED');
  });

  // ---- evidence attachments ------------------------------------------------------------

  it('B4-EVD-1 evidence documents are validated at create (closed keys, lowercase SHA-256, no repeats) and again by the DB CHECK; no bytes are stored', async () => {
    const t = await newTenant(pg);
    const version = await publishedVersion(pg, INCLUDED);
    const bad = async (contract: Record<string, unknown>): Promise<string[]> => {
      try {
        await create('SUBSCRIPTION_OPEN', t, { plan_key: INCLUDED, plan_version_id: version, replaces_subscription_id: null, contract });
      } catch (e) {
        if (e instanceof CommercialPayloadError) return [...e.errors];
        const inner = (e as { details?: { errors?: string[] } }).details?.errors;
        if (inner) return inner;
        throw e;
      }
      throw new Error('expected a payload refusal');
    };
    expect(await bad(recordBlock(ref(), { documents: [{ name: 'a.pdf', sha256: 'ABC' }] }))).toEqual(['contract.documents[0].sha256 must be a lowercase SHA-256 hex digest']);
    expect(await bad(recordBlock(ref(), { documents: [DOC_MSA, { ...DOC_MSA, name: 'copy.pdf' }] }))).toEqual(['contract.documents[1].sha256 repeats another document']);
    expect(await bad(recordBlock(ref(), { documents: [{ ...DOC_OF, bytes: 'JVBERi0' }] }))).toEqual(['contract.documents[0].bytes is not a field of this block']);
    expect(await bad(recordBlock('ct-1'))).toEqual(['contract.contract_ref must match ^[A-Z][A-Z0-9-]{2,39}$ (e.g. CT-2026-021)']);
    expect(await bad(recordBlock(ref(), { terms: [] }))).toEqual(['contract.terms must be an array of 1 to 50 terms']);
    // The DB CHECK is the backstop (a raw insert with a malformed document never lands).
    const cols = (await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'subscription' AND table_name IN ('Contract', 'ContractAmendment') AND data_type = 'bytea'`)).rows;
    expect(cols).toEqual([]);
    const valid = await pg.query(`SELECT subscription.ccp_b4_valid_evidence_documents($1::jsonb) AS ok`, [JSON.stringify([DOC_MSA])]);
    expect(valid.rows[0].ok).toBe(true);
    for (const d of [[{ name: 'x', sha256: 'z'.repeat(64) }], [{ name: '', sha256: DOC_OF.sha256 }], [{ name: 'x', sha256: DOC_OF.sha256, data: 'b' }], { name: 'x' }]) {
      expect((await pg.query(`SELECT subscription.ccp_b4_valid_evidence_documents($1::jsonb) AS ok`, [JSON.stringify(d)])).rows[0].ok).toBe(false);
    }
  });
});
