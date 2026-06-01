import { v7 as uuidv7 } from 'uuid';

// PR-A1c — recordUsage helper.
//
// Returns a PrismaPromise (an unawaited query) that the CALLER places
// into its existing $transaction([...]) array of a domain write. Because
// the project uses ONE Postgres database for all schemas, the
// cross-schema $executeRaw INSERT into metering."UsageEvent" runs in
// the same PG transaction as the caller's array — atomicity guaranteed
// (Ruling 6: usage event recorded iff the domain transaction commits).
//
// Design notes:
//   * Ruling 1: general stream. event_type is a free string; vocab
//     aligns with M6 PR-2 outbox event_type values for correlation
//     (e.g. 'engagement.state_transition'). NO enum constraint here.
//   * Ruling 2: no new transaction boundaries. The function is composed
//     into an EXISTING $transaction by the caller.
//   * Ruling 4: write path only. NO aggregation / read API / billing.
//   * Ruling 6: same-transaction guarantee. The caller's prisma client
//     issues the raw INSERT; rollback rolls both back.
//
// The `prisma` argument is structurally typed (any object with
// `$executeRaw`). Each domain repository injects its own per-module
// PrismaService; passing it here keeps metering a true leaf (no
// back-edge to any domain lib — metering does not import @aramo/
// engagement or @aramo/submittal).
//
// Return is the result of the caller's $executeRaw call (a
// PrismaPromise<number>); pass it through to $transaction([...])
// without awaiting.

export interface RecordUsageInput {
  tenant_id: string;
  event_type: string;
  quantity?: number;
}

interface PrismaRawCapable {
  $executeRaw: (
    template: TemplateStringsArray,
    ...values: unknown[]
  ) => unknown;
}

export function recordUsage<T extends PrismaRawCapable>(
  prisma: T,
  input: RecordUsageInput,
): ReturnType<T['$executeRaw']> {
  const id = uuidv7();
  const quantity = input.quantity ?? 1;
  return prisma.$executeRaw`
    INSERT INTO metering."UsageEvent" (id, tenant_id, event_type, quantity, occurred_at)
    VALUES (${id}::uuid, ${input.tenant_id}::uuid, ${input.event_type}, ${quantity}, NOW())
  ` as ReturnType<T['$executeRaw']>;
}
