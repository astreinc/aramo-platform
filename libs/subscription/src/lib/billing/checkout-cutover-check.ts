// CCP-A6 (Conversion Rule C-16, C-17) — the READ-ONLY pre-cutover check. Before the A6 gate is
// deployed to any environment holding real tenants it runs in ONE `BEGIN TRANSACTION READ ONLY`
// session and reports:
//   (a) every CheckoutIntent still CREATED for a tenant holding an open MANUAL row of the plan's
//       product (C-16 reference query, product-scoped after CCP-A4: the open row is the BASE row
//       of the intent plan's product);
//   (b) the open subscription rows counted by product, source and status;
//   (c) the open BillingReconciliationFlag rows counted by reason;
//   (d) each tenant holding an open MANUAL row: tenant, product, plan key, period anchor, status.
// C-17: any (a) row HALTS the cutover until the PO records a disposition for it (expire the
// provider session through a governed Stripe command, or accept that a completion is held under
// C-7). The check never writes (the session is READ ONLY) and never calls the provider.

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string): Promise<{ rows: R[] }>;
}

export interface CheckoutCutoverReport {
  open_intents_with_manual: Array<{ tenant_id: string; intent_id: string; plan_key: string; product_key: string; created_at: string; has_session: boolean }>;
  open_subscriptions: Array<{ product_key: string; source: string; status: string; n: number }>;
  open_flags: Array<{ reason: string; n: number }>;
  manual_tenants: Array<{ tenant_id: string; product_key: string; plan_key: string; period_anchor: string; status: string }>;
  /** C-17: true when (a) is non-empty. */
  halt: boolean;
}

export const C16_QUERY_A = `
SELECT ci.tenant_id::text AS tenant_id, ci.id::text AS intent_id, p.key AS plan_key, p.product_key,
       to_char(ci.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
       (ci.provider_session_ref IS NOT NULL) AS has_session
  FROM subscription."CheckoutIntent" ci
  JOIN subscription."Plan" p ON p.id = ci.plan_id
 WHERE ci.status = 'CREATED'
   AND EXISTS (SELECT 1 FROM subscription."TenantSubscription" ts
                WHERE ts.tenant_id = ci.tenant_id AND ts.ended_at IS NULL AND ts.source = 'MANUAL'
                  AND ts.product_key = p.product_key AND ts.composition_role = 'BASE')
 ORDER BY ci.tenant_id, ci.created_at, ci.id`;

export const C16_QUERY_B = `
SELECT product_key, source, status, count(*)::int AS n
  FROM subscription."TenantSubscription" WHERE ended_at IS NULL
 GROUP BY product_key, source, status ORDER BY product_key, source, status`;

export const C16_QUERY_C = `
SELECT reason, count(*)::int AS n
  FROM subscription."BillingReconciliationFlag" WHERE resolved_at IS NULL
 GROUP BY reason ORDER BY reason`;

export const C16_QUERY_D = `
SELECT ts.tenant_id::text AS tenant_id, ts.product_key, p.key AS plan_key,
       to_char(ts.period_anchor AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS period_anchor, ts.status
  FROM subscription."TenantSubscription" ts JOIN subscription."Plan" p ON p.id = ts.plan_id
 WHERE ts.ended_at IS NULL AND ts.source = 'MANUAL'
 ORDER BY ts.tenant_id, ts.product_key`;

/** Runs (a)–(d) in one READ ONLY transaction on a dedicated client and rolls it back. */
export async function checkoutCutoverReport(client: Queryable): Promise<CheckoutCutoverReport> {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const a = await client.query<CheckoutCutoverReport['open_intents_with_manual'][number]>(C16_QUERY_A);
    const b = await client.query<CheckoutCutoverReport['open_subscriptions'][number]>(C16_QUERY_B);
    const c = await client.query<CheckoutCutoverReport['open_flags'][number]>(C16_QUERY_C);
    const d = await client.query<CheckoutCutoverReport['manual_tenants'][number]>(C16_QUERY_D);
    return { open_intents_with_manual: a.rows, open_subscriptions: b.rows, open_flags: c.rows, manual_tenants: d.rows, halt: a.rows.length > 0 };
  } finally {
    await client.query('ROLLBACK');
  }
}

/** The dry-run text (one line per row, stable order). */
export function formatCheckoutCutoverReport(r: CheckoutCutoverReport): string[] {
  const out: string[] = ['[cutover-check] session: BEGIN TRANSACTION READ ONLY (rolled back; nothing written)'];
  out.push(`[cutover-check] (a) CREATED checkout intents for tenants with an open MANUAL row: ${r.open_intents_with_manual.length}`);
  for (const x of r.open_intents_with_manual) {
    out.push(`[cutover-check]   tenant=${x.tenant_id} intent=${x.intent_id} plan=${x.plan_key} product=${x.product_key} created_at=${x.created_at} provider_session=${x.has_session ? 'present' : 'absent'}`);
  }
  out.push(`[cutover-check] (b) open subscription rows by product / source / status: ${r.open_subscriptions.length} groups`);
  for (const x of r.open_subscriptions) out.push(`[cutover-check]   ${x.product_key} ${x.source} ${x.status}: ${x.n}`);
  out.push(`[cutover-check] (c) open reconciliation flags by reason: ${r.open_flags.length} reasons`);
  for (const x of r.open_flags) out.push(`[cutover-check]   ${x.reason}: ${x.n}`);
  out.push(`[cutover-check] (d) tenants with an open MANUAL row: ${r.manual_tenants.length}`);
  for (const x of r.manual_tenants) out.push(`[cutover-check]   tenant=${x.tenant_id} product=${x.product_key} plan=${x.plan_key} period_anchor=${x.period_anchor} status=${x.status}`);
  out.push(
    r.halt
      ? `[cutover-check] HALT (C-17): ${r.open_intents_with_manual.length} open intent(s) need a PO-recorded disposition before cutover.`
      : '[cutover-check] OK: no open checkout intent conflicts with a MANUAL subscription.',
  );
  return out;
}
