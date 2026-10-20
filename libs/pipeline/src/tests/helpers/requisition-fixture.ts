import { randomUUID } from 'node:crypto';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §5.3 / §2.6 — every Pipeline write now
// reads the requisition's status FOR SHARE inside its transaction and REFUSES a requisition
// that does not resolve in the tenant. The ONE shared fixture for hand-wired Pipeline substrate
// specs: the minimal requisition migration set (paths relative to libs/pipeline/src/tests, the
// convention of those specs' MIGRATIONS) + an idempotent seeder for an ordinary, non-terminal
// requisition (status left at the schema default — open / active — so it permits every activity).

export const REQUISITION_FIXTURE_MIGRATIONS: readonly string[] = [
  '../../../../libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
  '../../../../libs/requisition/prisma/migrations/20260907120000_add_requisition_postal_code/migration.sql',
];

interface RawExec {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** Ensure an ordinary (non-terminal) requisition row exists for (tenant, id). Idempotent. */
export async function ensureOpenRequisition(db: RawExec, tenant_id: string, requisition_id: string): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "requisition"."Requisition" ("id","tenant_id","title","company_id")
     VALUES ($1::uuid,$2::uuid,'pipeline fixture',$3::uuid) ON CONFLICT ("id") DO NOTHING`,
    requisition_id,
    tenant_id,
    randomUUID(),
  );
}

/** Seed a fresh ordinary requisition for `tenant_id` and return its id. */
export async function openRequisition(db: RawExec, tenant_id: string): Promise<string> {
  const id = randomUUID();
  await ensureOpenRequisition(db, tenant_id, id);
  return id;
}
