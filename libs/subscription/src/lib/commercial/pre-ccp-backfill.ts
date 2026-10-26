// CCP-A11 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A11) — the Astre backfill,
// DRY-RUN ONLY. Record: doc/ccp/slices/CCP-A11-pre-execution.md §3.
//
// What CCP needs for a pre-CCP governed (MANUAL) subscription, and who delivers it:
//   product_key / composition_role  A4 migration backfill            → verified here, never written
//   plan_version_id (version pin)   A5 migration v1 pin              → verified here, never written
//   entitlement provenance          A7 migration MIGRATION + ledger  → verified here, never written
//   commercial audit trail / a governed record of the pre-CCP grant → THE GAP: one append-only
//     CommercialAuditEvent COMMERCIAL_PRE_CCP_GRANT_RECORDED per open MANUAL BASE row that has no
//     governed open (CommercialChangeApplication) and no record yet.
//
// The only table a backfill would ever write is subscription."CommercialAuditEvent", which no
// effective-service reader reads. Nothing here touches a subscription, a pin, an entitlement or
// a usage row. No CommercialChangeRequest is created: an APPLIED request would need approvals and
// an application that never happened (DR-A11-1).
//
// planPreCcpBackfill runs in ONE `BEGIN TRANSACTION READ ONLY` session and rolls it back.
// applyPreCcpBackfill is NOT wired to any command: it exists so the fixture tests prove the
// planned writes are service-neutral and idempotent. Executing a backfill anywhere real needs
// separate PO authorization (PBD §7.5, A0-C15); it is never executed by CCP-A11.

import { createHash } from 'node:crypto';

export interface SqlClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export const PRE_CCP_RECORD_EVENT = 'COMMERCIAL_PRE_CCP_GRANT_RECORDED';
export const PRE_CCP_WITHDRAWN_EVENT = 'COMMERCIAL_PRE_CCP_GRANT_RECORD_WITHDRAWN';
export const PRE_CCP_RECORD_KIND = 'PRE_CCP_MANUAL_GRANT';
export const BACKFILL_ID = 'CCP-A11';
/** Advisory lock key (one backfill at a time); distinct from the billing lock namespace. */
export const BACKFILL_LOCK_KEY = 7_011_011_011;

/** The v1 checksums CCP-A5 recorded from the seed catalog (CCP-A5-acceptance §2). Informational. */
export const A5_SEED_V1_CHECKSUMS: Readonly<Record<string, string>> = {
  'aramo-sign-enterprise-v1': '051a982cdcc558268932efa0aaf3278d7d3a18904332645b25dff9e638670625',
  'aramo-sign-free-personal-v1': '32bf3be01fc36eaf85b5687a00be4a88cb4ab04659140bdb50240aea29b16607',
  'aramo-sign-included-v1': '6ec16b4a2d871fb0a1da7a890462e1b9a5721c68216d963df5acef700ad62bf8',
  'aramo-sign-standard-business-v1': 'b4414302cd48c8306f0daac3ce2326b44724ee084378b9bb4d2c1779446408a8',
  'aramo-sign-standard-professional-v1': '77d0409d75c1fa839f384234ef8a859064b38fcc0915c85aa7d7d2ddeefd79d7',
};

// ---- refusal guards --------------------------------------------------------------------------

export class BackfillRefusedError extends Error {
  constructor(
    readonly refusal: 'DRY_RUN_REQUIRED' | 'EXECUTE_NOT_AUTHORIZED' | 'DATABASE_URL_MISSING' | 'DATABASE_URL_NOT_LOCAL' | 'UNKNOWN_ARGUMENT',
    message: string,
  ) {
    super(message);
    this.name = 'BackfillRefusedError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True only for a postgres URL whose host is the loopback (a local DB or a testcontainer). */
export function isLocalDatabaseUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return false;
  // libpq/pg honour host / hostaddr query parameters over the authority: refuse any override.
  for (const k of u.searchParams.keys()) if (['host', 'hostaddr', 'service'].includes(k.toLowerCase())) return false;
  return LOCAL_HOSTS.has(u.hostname.toLowerCase());
}

export function assertLocalDatabaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) throw new BackfillRefusedError('DATABASE_URL_MISSING', 'no database URL (pass --database-url or set DATABASE_URL)');
  if (!isLocalDatabaseUrl(raw)) {
    throw new BackfillRefusedError('DATABASE_URL_NOT_LOCAL', 'refused: the database URL is not localhost or a testcontainer. Production is not authorized (PBD §7.5); nothing was connected.');
  }
  return raw;
}

export interface BackfillArgs {
  database_url: string;
}

/** CLI arguments. `--dry-run` is mandatory; `--execute` is always refused. */
export function parseBackfillArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): BackfillArgs {
  let dry = false;
  let url: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--dry-run') dry = true;
    else if (a === '--execute' || a.startsWith('--execute=')) {
      throw new BackfillRefusedError('EXECUTE_NOT_AUTHORIZED', 'refused: CCP-A11 has no execute path. Executing the backfill needs separate PO authorization and a separately authorized slice (PBD §7.5, A0-C15).');
    } else if (a === '--database-url') url = argv[++i];
    else if (a.startsWith('--database-url=')) url = a.slice('--database-url='.length);
    else throw new BackfillRefusedError('UNKNOWN_ARGUMENT', `refused: unknown argument ${a}`);
  }
  if (!dry) throw new BackfillRefusedError('DRY_RUN_REQUIRED', 'refused: --dry-run is required (the backfill is dry-run only).');
  return { database_url: assertLocalDatabaseUrl(url ?? env['DATABASE_URL']) };
}

// ---- the plan ----------------------------------------------------------------------------------

export type ExceptionSeverity = 'HALT' | 'REVIEW';

export interface BackfillException {
  code: string;
  severity: ExceptionSeverity;
  tenant_id: string | null;
  subscription_id: string | null;
  detail: string;
}

export interface PlannedRecord {
  id: string;
  tenant_id: string;
  subscription_id: string;
  subject: string;
  correlation_id: string;
  payload: Record<string, unknown>;
}

export interface BackfillPlan {
  schema_ready: boolean;
  schema_missing: string[];
  counts: Record<string, number>;
  open_by_product_source_status: Array<{ product_key: string; source: string; status: string; n: number }>;
  entitlements_by_source: Array<{ granted_source: string; active: number; revoked: number }>;
  exceptions: BackfillException[];
  planned: PlannedRecord[];
  /** Planned writes per table; every table not listed is 0. */
  planned_writes: Record<string, number>;
  halt: boolean;
}

/** Deterministic UUID (v7 layout bits) from a seed string. */
export function deterministicUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const recordIdFor = (subscription_id: string): string => deterministicUuid(`ccp-a11:pre-ccp-record:${subscription_id}`);

const REQUIRED_COLUMNS: ReadonlyArray<[string, string, string, string]> = [
  ['subscription', 'TenantSubscription', 'product_key', 'CCP-A4'],
  ['subscription', 'TenantSubscription', 'composition_role', 'CCP-A4'],
  ['subscription', 'TenantSubscription', 'plan_version_id', 'CCP-A5'],
  ['subscription', 'PlanVersion', 'content_checksum', 'CCP-A5'],
  ['subscription', 'CommercialAuditEvent', 'event_type', 'CCP-A2'],
  ['subscription', 'CommercialPolicyVersion', 'status', 'CCP-A2'],
  ['subscription', 'CommercialChangeApplication', 'subscription_id', 'CCP-A6'],
  ['entitlement', 'TenantEntitlement', 'granted_source', 'CCP-A7'],
  ['entitlement', 'TenantEntitlement', 'revoked_at', 'CCP-A7'],
];

async function missingSchema(c: SqlClient): Promise<string[]> {
  const r = await c.query(
    `SELECT table_schema || '.' || table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema IN ('subscription', 'entitlement')`,
  );
  const have = new Set(r.rows.map((x) => x.k as string));
  return REQUIRED_COLUMNS.filter(([s, t, col]) => !have.has(`${s}.${t}.${col}`)).map(([s, t, col, slice]) => `${s}."${t}".${col} (${slice})`);
}

const OPEN_ROWS_SQL = `
SELECT ts.id::text AS subscription_id, ts.tenant_id::text AS tenant_id, ts.product_key, ts.composition_role, ts.source, ts.status,
       p.key AS plan_key, p.product_key AS plan_product_key,
       ts.plan_version_id::text AS plan_version_id, v.version_number, v.status AS version_status, v.content_checksum,
       (subscription.ccp_plan_version_checksum(v.content) = v.content_checksum) AS checksum_ok,
       (subscription.ccp_plan_version_checksum(subscription.ccp_plan_live_content(p.id)) = v.content_checksum) AS equals_live,
       to_char(ts.period_anchor AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS period_anchor,
       to_char(ts.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
       (ts.billing_provider IS NOT NULL OR ts.billing_account_ref IS NOT NULL OR ts.billing_subscription_ref IS NOT NULL) AS billing_linked,
       EXISTS (SELECT 1 FROM subscription."CommercialChangeApplication" a
                WHERE a.subscription_id = ts.id AND a.action_type IN ('SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE')) AS governed_open,
       EXISTS (SELECT 1 FROM subscription."CommercialAuditEvent" e
                WHERE e.event_type = '${PRE_CCP_RECORD_EVENT}' AND e.subject = 'subscription:' || ts.id::text) AS recorded,
       EXISTS (SELECT 1 FROM subscription."CommercialAuditEvent" e
                WHERE e.event_type = '${PRE_CCP_WITHDRAWN_EVENT}' AND e.subject = 'subscription:' || ts.id::text) AS withdrawn,
       md5(row_to_json(ts)::text) AS row_md5
  FROM subscription."TenantSubscription" ts
  JOIN subscription."Plan" p ON p.id = ts.plan_id
  JOIN subscription."PlanVersion" v ON v.id = ts.plan_version_id
 WHERE ts.ended_at IS NULL
 ORDER BY ts.tenant_id, ts.product_key, ts.id`;

const ENTITLEMENTS_SQL = `
SELECT tenant_id::text AS tenant_id, capability::text AS capability, granted_source, (revoked_at IS NOT NULL) AS revoked, (change_request_id IS NOT NULL) AS governed
  FROM entitlement."TenantEntitlement" ORDER BY tenant_id, capability::text`;

interface OpenRow {
  subscription_id: string;
  tenant_id: string;
  product_key: string;
  composition_role: string;
  source: string;
  status: string;
  plan_key: string;
  plan_product_key: string;
  plan_version_id: string;
  version_number: number;
  version_status: string;
  content_checksum: string;
  checksum_ok: boolean;
  equals_live: boolean;
  period_anchor: string;
  started_at: string;
  billing_linked: boolean;
  governed_open: boolean;
  recorded: boolean;
  withdrawn: boolean;
  row_md5: string;
}

interface EntRow {
  tenant_id: string;
  capability: string;
  granted_source: string;
  revoked: boolean;
  governed: boolean;
}

/** SHA-256 of the canonical state a record describes (row hash + entitlements). No PII is stored. */
function stateChecksum(row: OpenRow, ents: readonly EntRow[]): string {
  const canon = JSON.stringify({ row_md5: row.row_md5, entitlements: ents.map((e) => [e.capability, e.granted_source, e.revoked]) });
  return createHash('sha256').update(canon).digest('hex');
}

/** Computes the plan in ONE read-only session (rolled back). Never writes. */
export async function planPreCcpBackfill(c: SqlClient): Promise<BackfillPlan> {
  await c.query('BEGIN TRANSACTION READ ONLY');
  try {
    return await planInSession(c);
  } finally {
    await c.query('ROLLBACK');
  }
}

async function planInSession(c: SqlClient): Promise<BackfillPlan> {
  const missing = await missingSchema(c);
  if (missing.length > 0) {
    return {
      schema_ready: false,
      schema_missing: missing,
      counts: {},
      open_by_product_source_status: [],
      entitlements_by_source: [],
      exceptions: [],
      planned: [],
      planned_writes: {},
      halt: true,
    };
  }
  const open = (await c.query(OPEN_ROWS_SQL)).rows as OpenRow[];
  const ents = (await c.query(ENTITLEMENTS_SQL)).rows as EntRow[];
  const entsOf = (t: string) => ents.filter((e) => e.tenant_id === t);
  const scalar = async (sql: string): Promise<number> => Number((await c.query(sql)).rows[0]?.n ?? 0);
  const policy = (await c.query(`SELECT id::text AS id FROM subscription."CommercialPolicyVersion" WHERE status = 'ACTIVE'`)).rows;
  const intents = (await c.query(
    `SELECT ci.tenant_id::text AS tenant_id, ci.id::text AS intent_id FROM subscription."CheckoutIntent" ci
       JOIN subscription."Plan" p ON p.id = ci.plan_id
      WHERE ci.status = 'CREATED' AND EXISTS (SELECT 1 FROM subscription."TenantSubscription" ts WHERE ts.tenant_id = ci.tenant_id AND ts.ended_at IS NULL
            AND ts.source = 'MANUAL' AND ts.product_key = p.product_key AND ts.composition_role = 'BASE')
      ORDER BY ci.tenant_id, ci.id`,
  )).rows as Array<{ tenant_id: string; intent_id: string }>;

  const exceptions: BackfillException[] = [];
  const ex = (code: string, severity: ExceptionSeverity, row: { tenant_id: string; subscription_id?: string } | null, detail: string) =>
    exceptions.push({ code, severity, tenant_id: row?.tenant_id ?? null, subscription_id: row?.subscription_id ?? null, detail });

  if (policy.length !== 1) ex('NO_ACTIVE_COMMERCIAL_POLICY', 'HALT', null, `ACTIVE CommercialPolicyVersion rows: ${policy.length} (expected 1)`);
  for (const i of intents) ex('OPEN_CHECKOUT_INTENT_FOR_MANUAL', 'HALT', { tenant_id: i.tenant_id }, `CheckoutIntent ${i.intent_id} is CREATED (Conv. C-16(a) / C-17)`);

  const planned: PlannedRecord[] = [];
  const policyId = policy[0]?.id as string | undefined;
  for (const r of open) {
    if (!r.checksum_ok) ex('PIN_CHECKSUM_MISMATCH', 'HALT', r, `pinned version ${r.plan_version_id} content does not re-hash to its checksum`);
    if (r.product_key !== r.plan_product_key || r.composition_role !== 'BASE') {
      ex('PRODUCT_DIMENSION_INVALID', 'HALT', r, `product_key=${r.product_key} plan_product_key=${r.plan_product_key} composition_role=${r.composition_role}`);
    }
    if (r.source === 'DEVELOPMENT') ex('DEVELOPMENT_ROW_OPEN', 'REVIEW', r, 'an open DEVELOPMENT row (local/test seed only)');
    if (r.source !== 'MANUAL') continue;
    if (r.billing_linked) ex('MANUAL_ROW_BILLING_LINKED', 'HALT', r, 'an open MANUAL row carries a provider billing link');
    if (!['ACTIVE', 'TRIALING'].includes(r.status)) ex('MANUAL_ROW_NOT_SENDING', 'REVIEW', r, `status ${r.status}`);
    const tents = entsOf(r.tenant_id);
    const productCap = r.product_key; // the v1 registry: product `sign` ⇔ capability `sign`
    const cap = tents.find((e) => e.capability === productCap);
    if (cap === undefined) ex('PRODUCT_CAPABILITY_MISSING', 'REVIEW', r, `no ${productCap} entitlement row; the backfill never grants one`);
    else if (cap.revoked) ex('PRODUCT_CAPABILITY_REVOKED', 'REVIEW', r, `${productCap} is revoked; the backfill never re-grants (resurrection guard)`);
    if (r.version_number !== 1 || !r.equals_live) {
      ex('PIN_NOT_LIVE_V1', 'REVIEW', r, `pinned v${r.version_number} (${r.version_status}); equals live rows: ${r.equals_live}`);
    }
    const seed = A5_SEED_V1_CHECKSUMS[r.plan_key];
    if (r.version_number === 1 && seed !== undefined && seed !== r.content_checksum) {
      ex('PIN_V1_DIFFERS_FROM_SEED', 'REVIEW', r, `v1 checksum ${r.content_checksum} differs from the A5 seed checksum (catalog drift; the pin follows the live rows)`);
    }
    if (r.withdrawn) {
      ex('RECORD_WITHDRAWN', 'REVIEW', r, 'a record was withdrawn by compensation; re-recording needs a new authorization');
      continue;
    }
    if (r.governed_open || r.recorded) continue;
    planned.push({
      id: recordIdFor(r.subscription_id),
      tenant_id: r.tenant_id,
      subscription_id: r.subscription_id,
      subject: `subscription:${r.subscription_id}`,
      correlation_id: `ccp-a11-backfill:${r.subscription_id}`,
      payload: {
        backfill: BACKFILL_ID,
        record_kind: PRE_CCP_RECORD_KIND,
        subscription_id: r.subscription_id,
        product_key: r.product_key,
        composition_role: r.composition_role,
        source: r.source,
        status: r.status,
        plan_key: r.plan_key,
        plan_version_id: r.plan_version_id,
        plan_version_number: r.version_number,
        plan_version_checksum: r.content_checksum,
        period_anchor: r.period_anchor,
        started_at: r.started_at,
        billing_linked: r.billing_linked,
        capabilities: tents.map((e) => ({ capability: e.capability, granted_source: e.granted_source, revoked: e.revoked })),
        state_checksum: stateChecksum(r, tents),
        policy_version_id: policyId ?? null,
      },
    });
  }

  const by = (pred: (r: OpenRow) => boolean) => open.filter(pred).length;
  const groups = new Map<string, number>();
  for (const r of open) groups.set(`${r.product_key}\u0000${r.source}\u0000${r.status}`, (groups.get(`${r.product_key}\u0000${r.source}\u0000${r.status}`) ?? 0) + 1);
  const entGroups = new Map<string, { active: number; revoked: number }>();
  for (const e of ents) {
    const g = entGroups.get(e.granted_source) ?? { active: 0, revoked: 0 };
    if (e.revoked) g.revoked++;
    else g.active++;
    entGroups.set(e.granted_source, g);
  }
  const manualOpen = open.filter((r) => r.source === 'MANUAL');
  const counts: Record<string, number> = {
    subscriptions_total: await scalar(`SELECT count(*)::int AS n FROM subscription."TenantSubscription"`),
    subscriptions_open: open.length,
    open_manual: manualOpen.length,
    open_manual_governed_by_change_request: manualOpen.filter((r) => r.governed_open).length,
    open_manual_already_recorded: manualOpen.filter((r) => r.recorded && !r.withdrawn).length,
    open_manual_withdrawn: manualOpen.filter((r) => r.withdrawn).length,
    open_manual_to_record: planned.length,
    open_self_service_not_in_scope: by((r) => r.source === 'SELF_SERVICE'),
    open_free_not_in_scope: by((r) => r.source === 'FREE'),
    open_development: by((r) => r.source === 'DEVELOPMENT'),
    open_pinned_checksum_ok: by((r) => r.checksum_ok),
    open_pinned_v1: by((r) => r.version_number === 1),
    open_product_sign_base: by((r) => r.product_key === 'sign' && r.composition_role === 'BASE'),
    entitlement_rows: ents.length,
    entitlement_rows_active: ents.filter((e) => !e.revoked).length,
    entitlement_rows_revoked: ents.filter((e) => e.revoked).length,
    checkout_intents: await scalar(`SELECT count(*)::int AS n FROM subscription."CheckoutIntent"`),
    checkout_intents_created_for_manual: intents.length,
    pre_ccp_records_existing: await scalar(`SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent" WHERE event_type = '${PRE_CCP_RECORD_EVENT}'`),
    exceptions_halt: exceptions.filter((e) => e.severity === 'HALT').length,
    exceptions_review: exceptions.filter((e) => e.severity === 'REVIEW').length,
  };
  exceptions.sort((a, b) => `${a.severity}|${a.code}|${a.tenant_id}|${a.subscription_id}|${a.detail}`.localeCompare(`${b.severity}|${b.code}|${b.tenant_id}|${b.subscription_id}|${b.detail}`));
  return {
    schema_ready: true,
    schema_missing: [],
    counts,
    open_by_product_source_status: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => {
      const [product_key, source, status] = k.split('\u0000') as [string, string, string];
      return { product_key, source, status, n };
    }),
    entitlements_by_source: [...entGroups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([granted_source, g]) => ({ granted_source, ...g })),
    exceptions,
    planned,
    planned_writes: {
      'subscription."CommercialAuditEvent"': planned.length,
      'subscription."TenantSubscription"': 0,
      'subscription."CommercialChangeRequest"': 0,
      'subscription."SubscriptionVersionPinEvent"': 0,
      'subscription."AllowanceUsage"': 0,
      'subscription."CapacityUsage"': 0,
      'entitlement."TenantEntitlement"': 0,
      'entitlement."TenantEntitlementEvent"': 0,
    },
    halt: exceptions.some((e) => e.severity === 'HALT'),
  };
}

/** The dry-run report: one line per fact, stable order, no run timestamps, no PII. */
export function formatBackfillPlan(p: BackfillPlan): string[] {
  const out = ['[ccp-a11] DRY RUN: session BEGIN TRANSACTION READ ONLY (rolled back; nothing written)'];
  if (!p.schema_ready) {
    out.push('[ccp-a11] schema not at CCP-A7; missing:');
    for (const m of p.schema_missing) out.push(`[ccp-a11]   ${m}`);
    out.push('[ccp-a11] REFUSED: apply the CCP migrations first (a local or fixture database only).');
    return out;
  }
  out.push('[ccp-a11] counts:');
  for (const [k, v] of Object.entries(p.counts)) out.push(`[ccp-a11]   ${k}: ${v}`);
  out.push(`[ccp-a11] open subscriptions by product / source / status: ${p.open_by_product_source_status.length} groups`);
  for (const g of p.open_by_product_source_status) out.push(`[ccp-a11]   ${g.product_key} ${g.source} ${g.status}: ${g.n}`);
  out.push(`[ccp-a11] entitlement rows by granted_source: ${p.entitlements_by_source.length} sources`);
  for (const g of p.entitlements_by_source) out.push(`[ccp-a11]   ${g.granted_source}: active ${g.active}, revoked ${g.revoked}`);
  out.push('[ccp-a11] planned writes (if ever executed under separate PO authorization):');
  for (const [t, n] of Object.entries(p.planned_writes)) out.push(`[ccp-a11]   ${t}: ${n}`);
  out.push(`[ccp-a11] planned records: ${p.planned.length}`);
  for (const r of p.planned) {
    const x = r.payload;
    out.push(
      `[ccp-a11]   ${PRE_CCP_RECORD_EVENT} id=${r.id} tenant=${r.tenant_id} subscription=${r.subscription_id} product=${String(x['product_key'])} plan=${String(x['plan_key'])} v${String(x['plan_version_number'])} status=${String(x['status'])} capabilities=${(x['capabilities'] as Array<{ capability: string; granted_source: string; revoked: boolean }>).map((c) => `${c.capability}:${c.granted_source}${c.revoked ? ':revoked' : ''}`).join(',')} state_checksum=${String(x['state_checksum'])}`,
    );
  }
  out.push(`[ccp-a11] exceptions: ${p.exceptions.length} (HALT ${p.counts['exceptions_halt'] ?? 0}, REVIEW ${p.counts['exceptions_review'] ?? 0})`);
  for (const e of p.exceptions) out.push(`[ccp-a11]   ${e.severity} ${e.code} tenant=${e.tenant_id ?? '-'} subscription=${e.subscription_id ?? '-'}: ${e.detail}`);
  out.push(p.halt ? '[ccp-a11] HALT: resolve every HALT exception before any execution is considered.' : '[ccp-a11] OK: no HALT exception. Effective-service writes planned: 0.');
  return out;
}

// ---- test-only apply (NOT wired to any command) -------------------------------------------------

export interface ApplyBackfillResult {
  inserted: string[];
  already_present: string[];
}

/**
 * Appends the planned records in ONE transaction under an advisory lock, re-planning inside it
 * (idempotent: a record already present is skipped; the id is deterministic). Used by the
 * CCP-A11 fixture tests only. Running it against any real database needs separate PO
 * authorization; `po_authorization_ref` is stored in each record.
 */
export async function applyPreCcpBackfill(c: SqlClient, opts: { po_authorization_ref: string }): Promise<ApplyBackfillResult> {
  if (opts.po_authorization_ref.trim().length === 0) throw new Error('po_authorization_ref is required');
  await c.query('BEGIN');
  try {
    await c.query('SELECT pg_advisory_xact_lock($1)', [BACKFILL_LOCK_KEY]);
    const plan = await planInSession(c);
    if (!plan.schema_ready || plan.halt) throw new Error(`backfill refused: ${plan.schema_ready ? 'HALT exceptions present' : 'schema not at CCP-A7'}`);
    const inserted: string[] = [];
    for (const r of plan.planned) {
      const res = await c.query(
        `INSERT INTO subscription."CommercialAuditEvent" (id, actor_id, actor_type, actor_role_keys, event_type, is_exception, tenant_id, subject, change_request_id, policy_version_id, payload, correlation_id)
         VALUES ($1::uuid, NULL, 'system', '{}', $2, false, $3::uuid, $4, NULL, $5::uuid, $6::jsonb, $7)
         ON CONFLICT (id) DO NOTHING RETURNING id::text AS id`,
        [r.id, PRE_CCP_RECORD_EVENT, r.tenant_id, r.subject, r.payload['policy_version_id'], JSON.stringify({ ...r.payload, po_authorization_ref: opts.po_authorization_ref }), r.correlation_id],
      );
      if (res.rows.length === 1) inserted.push(r.id);
    }
    await c.query('COMMIT');
    const already = (await c.query(`SELECT id::text AS id FROM subscription."CommercialAuditEvent" WHERE event_type = $1 ORDER BY id`, [PRE_CCP_RECORD_EVENT])).rows
      .map((x) => x.id as string)
      .filter((id) => !inserted.includes(id));
    return { inserted, already_present: already };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}
