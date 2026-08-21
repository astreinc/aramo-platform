// Serialized slot consumption (L8-B1, §6 Approach A — the safety heart).
//
// The quota decision is serialized with `SELECT … FOR UPDATE` on the policy
// control row BEFORE the count is read, so two simultaneous requests cannot both
// pass a limit (write-skew is impossible). The idempotency floor is the DB
// unique index on (tenant, requisition, talent), expressed as an
// `INSERT … ON CONFLICT DO NOTHING RETURNING` so the same Talent can never
// consume a slot twice.
//
// This is CONNECTION-AGNOSTIC parameterized raw SQL against the single
// `submittal_policy` schema — the SAME function the apps/api orchestrator runs
// inside its one interactive cross-schema transaction (TE-9: one consumption
// authority, no duplicated logic). It never opens its own transaction; the
// caller owns the tx boundary.

/** The minimal raw-SQL-capable transaction client both the lib's PrismaService
 * tx and the orchestrator's connection satisfy. */
export interface RawTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export type ConsumeResult =
  | { readonly status: 'CONSUMED'; readonly consumption_id: string }
  | { readonly status: 'ALREADY_CONSUMED'; readonly consumption_id: string }
  | { readonly status: 'LIMIT_REACHED' };

export interface ConsumeSlotInput {
  readonly tenant_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly submittal_id: string;
  /** Effective supplier slot cap; NULL ⇒ unbounded (no lock, no count). */
  readonly limit: number | null;
}

const SCHEMA = 'submittal_policy';

/**
 * Consume one submittal slot within the CALLER's transaction. Order:
 * lock policy row (FOR UPDATE) → count → limit gate → idempotent insert.
 * Returns a typed result; the caller maps LIMIT_REACHED → the 4xx ErrorCode.
 */
export async function consumeSlot(
  tx: RawTx,
  input: ConsumeSlotInput,
): Promise<ConsumeResult> {
  if (input.limit !== null) {
    // Serialize the limit decision: block a concurrent consumer on the one
    // policy control row until we commit. Requires a policy row to exist (the
    // limit lives there).
    await tx.$queryRawUnsafe(
      `SELECT "id" FROM "${SCHEMA}"."RequisitionSubmittalPolicy" WHERE "tenant_id" = $1::uuid AND "requisition_id" = $2::uuid FOR UPDATE`,
      input.tenant_id,
      input.requisition_id,
    );
    const counted = await tx.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS "n" FROM "${SCHEMA}"."SubmittalConsumption" WHERE "tenant_id" = $1::uuid AND "requisition_id" = $2::uuid`,
      input.tenant_id,
      input.requisition_id,
    );
    if ((counted[0]?.n ?? 0) >= input.limit) {
      return { status: 'LIMIT_REACHED' };
    }
  }

  const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO "${SCHEMA}"."SubmittalConsumption" ("tenant_id", "requisition_id", "talent_record_id", "submittal_id") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid) ON CONFLICT ("tenant_id", "requisition_id", "talent_record_id") DO NOTHING RETURNING "id"`,
    input.tenant_id,
    input.requisition_id,
    input.talent_record_id,
    input.submittal_id,
  );
  const insertedRow = inserted[0];
  if (insertedRow !== undefined) {
    return { status: 'CONSUMED', consumption_id: insertedRow.id };
  }

  // ON CONFLICT DO NOTHING ⇒ the Talent already holds a slot (idempotent).
  const existing = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "${SCHEMA}"."SubmittalConsumption" WHERE "tenant_id" = $1::uuid AND "requisition_id" = $2::uuid AND "talent_record_id" = $3::uuid`,
    input.tenant_id,
    input.requisition_id,
    input.talent_record_id,
  );
  const existingRow = existing[0];
  if (existingRow === undefined) {
    throw new Error(
      'submittal consumption invariant violated: conflict row not found',
    );
  }
  return { status: 'ALREADY_CONSUMED', consumption_id: existingRow.id };
}
