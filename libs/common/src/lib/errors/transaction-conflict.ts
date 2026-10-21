import { AramoError } from './aramo-error.js';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §2.2 T-3 — explicit interactive-
// transaction bounds and the typed RETRYABLE conflict for the transactions S1/S2 touch.
//
// A lock-wait/transaction timeout (Prisma P2028), a deadlock (Postgres 40P01), a lock that
// could not be acquired (55P03) or a serialization failure (40001) aborts the WHOLE
// transaction — every write in it rolls back — so the command had NO effect. It is surfaced
// as 409 TRANSACTION_CONFLICT_RETRYABLE instead of a raw 500. The SERVER NEVER RETRIES
// (v1.2 T-3 / LR-F check 2): the 409 goes back to the caller, whose retry is safe under the
// command's own idempotency contract (Idempotency-Key replay or the CAS expected_version)
// or is a fresh caller action. Non-idempotent external effects (email, call, e-sign) run
// OUTSIDE these transactions (T-4), so a retry can never duplicate them.

/** Interactive-transaction bounds (ms) for the S1/S2 lock-taking transactions. */
export const LOCKED_TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

/**
 * SERVER-side bound on any single lock wait inside a locked transaction — the FIRST statement
 * of every S1/S2 lock-taking transaction. Prisma's `timeout` cannot interrupt a statement that
 * is blocked in Postgres on a row/advisory lock, so without this a wait would hang until the
 * holder releases. 10s < the 15s transaction timeout: a blocked wait fails with 55P03 and
 * surfaces as 409 TRANSACTION_CONFLICT_RETRYABLE (the whole transaction rolled back).
 */
export const LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '10000ms'`;

const RETRYABLE_SQLSTATES = new Set(['40P01', '55P03', '40001']);
const RETRYABLE_MESSAGE = /deadlock detected|lock timeout|could not obtain lock|could not serialize access|Transaction already closed|expired transaction/i;

/** True when `err` is a transaction-level abort that left no effect and may be retried. */
export function isRetryableTransactionConflict(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    meta?: { code?: unknown };
    cause?: { code?: unknown; originalCode?: unknown; kind?: unknown };
    message?: unknown;
  };
  if (e.code === 'P2028') return true;
  const codes = [e.code, e.meta?.code, e.cause?.code, e.cause?.originalCode];
  if (codes.some((c) => typeof c === 'string' && RETRYABLE_SQLSTATES.has(c))) return true;
  return typeof e.message === 'string' && RETRYABLE_MESSAGE.test(e.message);
}

/**
 * Map a retryable transaction abort to 409 TRANSACTION_CONFLICT_RETRYABLE; rethrow
 * everything else unchanged (AramoErrors thrown inside the transaction pass through).
 */
export function rethrowTransactionConflict(err: unknown, requestId: string, operation: string): never {
  if (!(err instanceof AramoError) && isRetryableTransactionConflict(err)) {
    throw new AramoError(
      'TRANSACTION_CONFLICT_RETRYABLE',
      'The operation conflicted with a concurrent change and was not applied; retry',
      409,
      { requestId, details: { operation } },
    );
  }
  throw err;
}
