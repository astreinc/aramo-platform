// Talent Lifecycle R1–R5 Implementation Directive v1.2 §4.4 — the client-submittal
// policy LINEARIZATION protocol (LR-F C-1 / PO ruling C-1: immediate effect).
//
// One transaction-scoped advisory lock per tenant, K = hashtextextended('csp:'||tenant, 0),
// covering every scope layer (a TENANT publish can change every client's effective result).
//   - WRITER (publish): EXCLUSIVE K as the FIRST statement of the publish transaction, then
//     effective_from := clock_timestamp() (DATABASE clock, read under the lock).
//   - READERS (Qualified, client submit): SHARED K as the FIRST statement of their
//     transaction, then t_L := clock_timestamp() — the linearization instant at which the
//     effective policy is resolved.
// Advisory locks are database-wide, so they serialize across the per-lib Prisma pools on
// the one DATABASE_URL. A publish committed before a reader acquires K has
// effective_from < t_L (applied); a publish that starts while a reader holds K waits until
// the reader commits (not applied to it). `now()` is NOT used: inside a reader transaction
// it is the transaction START time, which can precede a concurrent publish's commit.

export interface CspLockCapableTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

const LOCK_KEY_SQL = `hashtextextended('csp:' || $1::text, 0)`;

/** WRITER — exclusive per-tenant lock; must be the first statement of the publish tx. */
export async function acquireCspPublishLock(tx: CspLockCapableTx, tenantId: string): Promise<void> {
  await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(${LOCK_KEY_SQL})::text AS locked`, tenantId);
}

/** READER — shared per-tenant lock; must be the first statement of the reader tx. */
export async function acquireCspReadLock(tx: CspLockCapableTx, tenantId: string): Promise<void> {
  await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock_shared(${LOCK_KEY_SQL})::text AS locked`, tenantId);
}

/** The database clock instant, read AFTER the lock is held (t_L / effective_from). */
export async function readDatabaseClock(tx: CspLockCapableTx): Promise<Date> {
  const rows = await tx.$queryRawUnsafe<Array<{ t: Date }>>(`SELECT clock_timestamp() AS t`);
  return new Date(rows[0]!.t);
}
