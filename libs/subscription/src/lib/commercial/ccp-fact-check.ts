// CCP-A11 (PBD §5.1 row A11 "the read-only production fact-check script") — the facts a backfill
// decision needs, read in ONE `BEGIN TRANSACTION READ ONLY` session that is always rolled back.
// It prints counts and states only: no secret, no email, no name, no provider reference value
// (a billing link is reported as present / absent). It runs on the pre-CCP schema (production
// today) and on the post-CCP-A7 schema; a column or table a slice has not added yet is reported
// as "n/a" instead of failing.
//
// Running it against production is a production read: it needs its own PO authorization
// (row A11 HALT). The command refuses a non-local URL unless --po-authorization-ref is given.
// CCP-A11 runs it against the fixture only.

import { BackfillRefusedError, PRE_CCP_RECORD_EVENT, isLocalDatabaseUrl, type SqlClient } from './pre-ccp-backfill.js';

export interface FactCheckArgs {
  database_url: string;
  po_authorization_ref: string | null;
}

export function parseFactCheckArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): FactCheckArgs {
  let url: string | undefined;
  let ref: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--database-url') url = argv[++i];
    else if (a.startsWith('--database-url=')) url = a.slice('--database-url='.length);
    else if (a === '--po-authorization-ref') ref = argv[++i] ?? null;
    else if (a.startsWith('--po-authorization-ref=')) ref = a.slice('--po-authorization-ref='.length);
    else throw new BackfillRefusedError('UNKNOWN_ARGUMENT', `refused: unknown argument ${a}`);
  }
  const database_url = url ?? env['DATABASE_URL'];
  if (database_url === undefined || database_url.length === 0) throw new BackfillRefusedError('DATABASE_URL_MISSING', 'no database URL (pass --database-url or set DATABASE_URL)');
  if (ref !== null && ref.trim().length === 0) ref = null;
  if (!isLocalDatabaseUrl(database_url) && ref === null) {
    throw new BackfillRefusedError(
      'DATABASE_URL_NOT_LOCAL',
      'refused: a non-local database is a production read; it needs a separate PO authorization (--po-authorization-ref <ref>). Nothing was connected.',
    );
  }
  return { database_url, po_authorization_ref: ref };
}

export interface FactCheckReport {
  schema: { stage: 'pre-CCP' | 'partial' | 'CCP-A7'; present: string[]; absent: string[] };
  open_subscriptions: Array<{ product_key: string; source: string; status: string; n: number }>;
  subscriptions_by_source: Array<{ source: string; open: number; total: number }>;
  manual_tenants: Array<{
    tenant_id: string;
    open_subscriptions: number;
    plan_key: string;
    status: string;
    started_on: string;
    period_anchor_on: string;
    billing_link: 'present' | 'absent';
    plan_version: string;
    entitlements: string[];
  }>;
  checkout_intents: Array<{ status: string; n: number }>;
  checkout_intents_total: number;
  entitlements_by_capability: Array<{ capability: string; key: string; n: number }>;
  catalog: { roles: number; scopes: number; role_scopes: number };
  plans: number;
  plan_versions: Array<{ status: string; n: number }> | 'n/a';
  pre_ccp_records: number | 'n/a';
  change_requests_by_kind: Array<{ kind: string; n: number }> | 'n/a';
}

const MARKERS: ReadonlyArray<[string, string]> = [
  ['subscription.CommercialAuditEvent.event_type', 'A2'],
  ['subscription.CommercialChangeRequest.kind', 'A3'],
  ['subscription.TenantSubscription.product_key', 'A4'],
  ['subscription.TenantSubscription.plan_version_id', 'A5'],
  ['subscription.CommercialChangeApplication.subscription_id', 'A6'],
  ['entitlement.TenantEntitlement.granted_source', 'A7'],
];

/** Runs the fact queries in one READ ONLY transaction on a dedicated client and rolls it back. */
export async function ccpFactCheck(c: SqlClient): Promise<FactCheckReport> {
  await c.query('BEGIN TRANSACTION READ ONLY');
  try {
    const cols = new Set(
      (await c.query(`SELECT table_schema || '.' || table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema IN ('subscription', 'entitlement', 'identity')`)).rows.map(
        (r) => r.k as string,
      ),
    );
    const present = MARKERS.filter(([k]) => cols.has(k)).map(([k, s]) => `${s} ${k}`);
    const absent = MARKERS.filter(([k]) => !cols.has(k)).map(([k, s]) => `${s} ${k}`);
    const stage = absent.length === 0 ? 'CCP-A7' : present.length === 0 ? 'pre-CCP' : 'partial';
    const hasProduct = cols.has('subscription.TenantSubscription.product_key');
    const hasPin = cols.has('subscription.TenantSubscription.plan_version_id');
    const hasSource = cols.has('entitlement.TenantEntitlement.granted_source');
    const hasRevoke = cols.has('entitlement.TenantEntitlement.revoked_at');
    const productExpr = hasProduct ? 'ts.product_key' : `'(pre-A4)'`;

    const open = (await c.query(
      `SELECT ${productExpr} AS product_key, ts.source, ts.status, count(*)::int AS n FROM subscription."TenantSubscription" ts
        WHERE ts.ended_at IS NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
    )).rows as FactCheckReport['open_subscriptions'];
    const bySource = (await c.query(
      `SELECT source, count(*) FILTER (WHERE ended_at IS NULL)::int AS open, count(*)::int AS total FROM subscription."TenantSubscription" GROUP BY source ORDER BY source`,
    )).rows as FactCheckReport['subscriptions_by_source'];

    const entExpr = `e.capability::text${hasSource ? ` || ':' || e.granted_source` : ''}${hasRevoke ? ` || CASE WHEN e.revoked_at IS NOT NULL THEN ':revoked' ELSE '' END` : ''}`;
    const manual = (await c.query(
      `SELECT ts.tenant_id::text AS tenant_id,
              (SELECT count(*)::int FROM subscription."TenantSubscription" o WHERE o.tenant_id = ts.tenant_id AND o.ended_at IS NULL) AS open_subscriptions,
              p.key AS plan_key, ts.status,
              to_char(ts.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS started_on,
              to_char(ts.period_anchor AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS period_anchor_on,
              CASE WHEN ts.billing_provider IS NOT NULL OR ts.billing_account_ref IS NOT NULL OR ts.billing_subscription_ref IS NOT NULL THEN 'present' ELSE 'absent' END AS billing_link,
              ${hasPin ? `(SELECT 'v' || v.version_number || ' ' || v.status FROM subscription."PlanVersion" v WHERE v.id = ts.plan_version_id)` : `'n/a (pre-A5)'`} AS plan_version,
              COALESCE((SELECT array_agg(${entExpr} ORDER BY e.capability::text) FROM entitlement."TenantEntitlement" e WHERE e.tenant_id = ts.tenant_id), '{}') AS entitlements
         FROM subscription."TenantSubscription" ts JOIN subscription."Plan" p ON p.id = ts.plan_id
        WHERE ts.ended_at IS NULL AND ts.source = 'MANUAL'
        ORDER BY ts.tenant_id, p.key`,
    )).rows as FactCheckReport['manual_tenants'];

    const intents = (await c.query(`SELECT status, count(*)::int AS n FROM subscription."CheckoutIntent" GROUP BY status ORDER BY status`)).rows as FactCheckReport['checkout_intents'];
    const ents = (await c.query(
      `SELECT e.capability::text AS capability, ${hasSource ? 'e.granted_source' : `'(pre-A7)'`}${hasRevoke ? ` || CASE WHEN e.revoked_at IS NOT NULL THEN ':revoked' ELSE '' END` : ''} AS key, count(*)::int AS n
         FROM entitlement."TenantEntitlement" e GROUP BY 1, 2 ORDER BY 1, 2`,
    )).rows as FactCheckReport['entitlements_by_capability'];
    const cat = (await c.query(
      `SELECT (SELECT count(*)::int FROM identity."Role") AS roles, (SELECT count(*)::int FROM identity."Scope") AS scopes, (SELECT count(*)::int FROM identity."RoleScope") AS role_scopes`,
    )).rows[0] as FactCheckReport['catalog'];
    const plans = Number((await c.query(`SELECT count(*)::int AS n FROM subscription."Plan"`)).rows[0]?.n ?? 0);
    const versions = hasPin
      ? ((await c.query(`SELECT status, count(*)::int AS n FROM subscription."PlanVersion" GROUP BY status ORDER BY status`)).rows as Array<{ status: string; n: number }>)
      : 'n/a';
    const records = cols.has('subscription.CommercialAuditEvent.event_type')
      ? Number((await c.query(`SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent" WHERE event_type = $1`, [PRE_CCP_RECORD_EVENT])).rows[0]?.n ?? 0)
      : 'n/a';
    const kinds = cols.has('subscription.CommercialChangeRequest.kind')
      ? ((await c.query(`SELECT kind, count(*)::int AS n FROM subscription."CommercialChangeRequest" GROUP BY kind ORDER BY kind`)).rows as Array<{ kind: string; n: number }>)
      : 'n/a';
    return {
      schema: { stage, present, absent },
      open_subscriptions: open,
      subscriptions_by_source: bySource,
      manual_tenants: manual,
      checkout_intents: intents,
      checkout_intents_total: intents.reduce((s, x) => s + x.n, 0),
      entitlements_by_capability: ents,
      catalog: cat,
      plans,
      plan_versions: versions,
      pre_ccp_records: records,
      change_requests_by_kind: kinds,
    };
  } finally {
    await c.query('ROLLBACK');
  }
}

export function formatFactCheck(r: FactCheckReport): string[] {
  const P = '[ccp-fact-check]';
  const out = [`${P} session: BEGIN TRANSACTION READ ONLY (rolled back; nothing written; counts and states only)`];
  out.push(`${P} schema stage: ${r.schema.stage} (present ${r.schema.present.length}, absent ${r.schema.absent.length})`);
  for (const a of r.schema.absent) out.push(`${P}   absent: ${a}`);
  out.push(`${P} (1) open subscriptions by product / source / status: ${r.open_subscriptions.length} groups`);
  for (const g of r.open_subscriptions) out.push(`${P}   ${g.product_key} ${g.source} ${g.status}: ${g.n}`);
  out.push(`${P} (2) subscriptions by source (open / total): ${r.subscriptions_by_source.length} sources`);
  for (const g of r.subscriptions_by_source) out.push(`${P}   ${g.source}: ${g.open} / ${g.total}`);
  out.push(`${P} (3) tenants with an open MANUAL row: ${r.manual_tenants.length}`);
  for (const t of r.manual_tenants) {
    out.push(
      `${P}   tenant=${t.tenant_id} open_subscriptions=${t.open_subscriptions} plan=${t.plan_key} status=${t.status} started_on=${t.started_on} period_anchor_on=${t.period_anchor_on} billing_link=${t.billing_link} plan_version=${t.plan_version} entitlements=${t.entitlements.join(',')}`,
    );
  }
  out.push(`${P} (4) checkout intents: ${r.checkout_intents_total}`);
  for (const g of r.checkout_intents) out.push(`${P}   ${g.status}: ${g.n}`);
  out.push(`${P} (5) entitlement rows by capability / source: ${r.entitlements_by_capability.length} groups`);
  for (const g of r.entitlements_by_capability) out.push(`${P}   ${g.capability} ${g.key}: ${g.n}`);
  out.push(`${P} (6) identity catalog roles / scopes / role-scopes: ${r.catalog.roles} / ${r.catalog.scopes} / ${r.catalog.role_scopes}`);
  out.push(`${P} (7) plans: ${r.plans}; plan versions: ${r.plan_versions === 'n/a' ? 'n/a (pre-A5)' : r.plan_versions.map((v) => `${v.status} ${v.n}`).join(', ') || '0'}`);
  out.push(`${P} (8) ${PRE_CCP_RECORD_EVENT} records: ${r.pre_ccp_records === 'n/a' ? 'n/a (pre-A2)' : r.pre_ccp_records}`);
  out.push(`${P} (9) change requests by kind: ${r.change_requests_by_kind === 'n/a' ? 'n/a (pre-A3)' : r.change_requests_by_kind.map((k) => `${k.kind} ${k.n}`).join(', ') || '0'}`);
  return out;
}
