import type { Capability } from './capability.js';
import { isCapability } from './capability.js';

// CCP-A7 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A7; Charter D1; Conversion Rule
// C-20; Successor Record v1.2 §3.6) — entitlement provenance, the governed revoke and the
// resurrection guard, as ONE set of raw statements shared by every writer (the repository on the
// entitlement client, and grantCapabilitiesInTx / revokeCapabilitiesInTx on a caller's
// transaction). The value list is fixed in doc/ccp/slices/CCP-A7-pre-execution.md §2 and mirrors
// the DB CHECK of migration 20261026000000.
//
// The resurrection guard: the grant is an UPSERT (the former createMany skipDuplicates) whose
// UPDATE branch fires ONLY for a revoked row AND a governed grant (a change request). An active
// row is never re-stamped; an ungoverned grant (provisioning, signup, the seed reconcile) never
// clears a revoke. The BEFORE UPDATE trigger backs the same rule in the database.

/** The Part IV values (kept, none renamed) plus the A7 additions PROVISIONING and SIGNUP. */
export const GRANTED_SOURCES = ['MANUAL', 'PLAN', 'PROMOTION', 'MIGRATION', 'PROVISIONING', 'SIGNUP'] as const;
export type GrantedSource = (typeof GRANTED_SOURCES)[number];

/** Commercial provenance (a governed change request is recorded on the row). */
export const COMMERCIAL_GRANTED_SOURCES: readonly GrantedSource[] = ['MANUAL', 'PLAN', 'PROMOTION'];
/** The governed grant sources a change-request apply writes (A6 / A7). */
export type GovernedGrantSource = 'MANUAL' | 'PLAN';
/** Ungoverned (non-commercial) sources: never evidence of payment (C-20), never clear a revoke. */
export type UngovernedGrantSource = 'PROVISIONING' | 'SIGNUP';

export function isGrantedSource(value: unknown): value is GrantedSource {
  return typeof value === 'string' && (GRANTED_SOURCES as readonly string[]).includes(value);
}

/**
 * Conv. C-20: only a commercial source is a commercial grant. A signup or provisioning grant
 * (and a pre-A7 MIGRATION row) is not evidence of payment, and reconciliation never revokes it
 * because no subscription exists.
 */
export function isCommercialGrantSource(source: string): boolean {
  return (COMMERCIAL_GRANTED_SOURCES as readonly string[]).includes(source);
}

export interface PrismaRawQueryCapable {
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
}

export class UnknownCapabilityError extends Error {
  constructor(readonly capability: string) {
    super(`unknown capability ${capability}`);
    this.name = 'UnknownCapabilityError';
  }
}

export interface EntitlementGrantInput {
  tenant_id: string;
  capabilities: readonly string[];
  granted_source: GrantedSource;
  /** The acting principal (operator, system actor), when known. */
  granted_by?: string | null;
  /** Set exactly for a commercial (governed) source; it is what may clear a revoke. */
  change_request_id?: string | null;
}

export interface EntitlementGrantOutcome {
  /** Newly inserted, or restored from a revoke by this governed grant (sorted). */
  granted: Capability[];
  /** Already active (left exactly as it was, provenance included) (sorted). */
  already_held: Capability[];
  /** Revoked and NOT restored: an ungoverned grant never clears a governed revoke (sorted). */
  withheld_revoked: Capability[];
}

function wantedCapabilities(capabilities: readonly string[]): Capability[] {
  const wanted = [...new Set(capabilities)];
  for (const c of wanted) if (!isCapability(c)) throw new UnknownCapabilityError(c);
  return (wanted as Capability[]).sort();
}

function assertProvenance(input: EntitlementGrantInput): void {
  if (!isGrantedSource(input.granted_source)) throw new Error(`unknown granted_source ${String(input.granted_source)}`);
  const governed = input.change_request_id !== undefined && input.change_request_id !== null;
  if (isCommercialGrantSource(input.granted_source) !== governed) {
    throw new Error(`granted_source ${input.granted_source} ${governed ? 'must not' : 'must'} carry a change request`);
  }
}

/**
 * The grant upsert (one statement), then the ledger row for every capability it withheld. Runs
 * on whatever client it is given: inside the caller's transaction for a governed apply.
 */
export async function upsertEntitlements(db: PrismaRawQueryCapable, input: EntitlementGrantInput): Promise<EntitlementGrantOutcome> {
  assertProvenance(input);
  const wanted = wantedCapabilities(input.capabilities);
  if (wanted.length === 0) return { granted: [], already_held: [], withheld_revoked: [] };
  const rows = await db.$queryRawUnsafe<Array<{ capability: string; outcome: string }>>(
    `WITH wanted AS (
       SELECT c::entitlement."Capability" AS capability FROM unnest($2::text[]) AS c
     ),
     prior AS (
       SELECT e.capability, e.revoked_at FROM entitlement."TenantEntitlement" e
        WHERE e.tenant_id = $1::uuid AND e.capability IN (SELECT capability FROM wanted)
     ),
     written AS (
       INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source, granted_by, change_request_id)
       SELECT $1::uuid, w.capability, $3, $4::uuid, $5::uuid FROM wanted w
       ON CONFLICT (tenant_id, capability) DO UPDATE
          SET revoked_at = NULL, revoked_by = NULL, revoke_change_request_id = NULL,
              granted_source = EXCLUDED.granted_source, granted_by = EXCLUDED.granted_by,
              change_request_id = EXCLUDED.change_request_id, granted_at = CURRENT_TIMESTAMP
        WHERE "TenantEntitlement".revoked_at IS NOT NULL AND EXCLUDED.change_request_id IS NOT NULL
       RETURNING capability
     )
     SELECT w.capability::text AS capability,
            CASE WHEN EXISTS (SELECT 1 FROM written x WHERE x.capability = w.capability) THEN 'granted'
                 WHEN EXISTS (SELECT 1 FROM prior p WHERE p.capability = w.capability AND p.revoked_at IS NOT NULL) THEN 'withheld_revoked'
                 ELSE 'already_held' END AS outcome
       FROM wanted w`,
    input.tenant_id,
    wanted,
    input.granted_source,
    input.granted_by ?? null,
    input.change_request_id ?? null,
  );
  const of = (o: string) => rows.filter((r) => r.outcome === o).map((r) => r.capability as Capability).sort();
  const outcome = { granted: of('granted'), already_held: of('already_held'), withheld_revoked: of('withheld_revoked') };
  if (outcome.withheld_revoked.length > 0) {
    await db.$queryRawUnsafe(
      `INSERT INTO entitlement."TenantEntitlementEvent" (tenant_id, capability, event_type, granted_source, actor_id)
       SELECT $1::uuid, c::entitlement."Capability", 'RESURRECTION_REFUSED', $3, $4::uuid FROM unnest($2::text[]) AS c
       RETURNING id`,
      input.tenant_id,
      outcome.withheld_revoked,
      input.granted_source,
      input.granted_by ?? null,
    );
  }
  return outcome;
}

export interface EntitlementRevokeInput {
  tenant_id: string;
  capabilities: readonly string[];
  revoked_by: string;
  /** A revoke is governed only (DB CHECK). */
  revoke_change_request_id: string;
}

/**
 * The governed revoke: marks each ACTIVE row revoked (the row is kept; its grant provenance is
 * untouched). Returns the capabilities this call revoked (sorted); an absent or already revoked
 * capability is not in the result (the caller decides whether that is a failure).
 */
export async function revokeEntitlements(db: PrismaRawQueryCapable, input: EntitlementRevokeInput): Promise<Capability[]> {
  const wanted = wantedCapabilities(input.capabilities);
  if (wanted.length === 0) return [];
  const rows = await db.$queryRawUnsafe<Array<{ capability: string }>>(
    `UPDATE entitlement."TenantEntitlement"
        SET revoked_at = CURRENT_TIMESTAMP, revoked_by = $3::uuid, revoke_change_request_id = $4::uuid
      WHERE tenant_id = $1::uuid AND capability::text = ANY($2::text[]) AND revoked_at IS NULL
      RETURNING capability::text AS capability`,
    input.tenant_id,
    wanted,
    input.revoked_by,
    input.revoke_change_request_id,
  );
  return rows.map((r) => r.capability as Capability).sort();
}
