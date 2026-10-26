// CCP-A6 (Conversion Rule §3.1, C-1, C-2, C-6, C-21) — the shared billing lock and the
// governed-subscription predicate, used by BOTH the self-service path
// (SubscriptionLifecycleService: checkout initiation and webhook application) and the governed
// path (CommercialApplyService), so console and provider writes for one tenant serialize.

type RawExecutor = { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number> };

/** The shared billing lock key (Conversion Rule §3.1). */
export function billingLockKey(tenant_id: string): string {
  return `billing:${tenant_id}`;
}

/**
 * pg_advisory_xact_lock(hashtextextended('billing:' || tenant_id, 0)) — held until the caller's
 * transaction ends. Every billing write for the tenant takes it first.
 */
export async function takeBillingLock(tx: RawExecutor, tenant_id: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${billingLockKey(tenant_id)}, 0))`;
}

/**
 * Conversion Rule §3.1 — an open subscription row is GOVERNED when (a) source = 'MANUAL'.
 * (b) contract-linked rows (CCP-B4): the Contract insert guard (migration 20261026030000) admits
 * a contract only on an open MANUAL BASE row with no provider link, so (b) ⊆ (a) by construction
 * and this predicate needs no contract read. (c) rows opened or last changed by
 * an applied change request are MANUAL by construction in CCP-A6 (SUBSCRIPTION_OPEN writes a
 * MANUAL row; SUBSCRIPTION_CHANGE / _END act on MANUAL rows only). DEVELOPMENT and FREE rows
 * are not governed (§3.1).
 */
export function isGovernedSubscription(row: { source: string; ended_at: Date | null }): boolean {
  return row.ended_at === null && row.source === 'MANUAL';
}

/** The C-7(b) hold reason (BillingReconciliationFlag.reason) and the C-4 refusal detail. */
export const GOVERNED_SUBSCRIPTION_OPEN = 'governed_subscription_open';
