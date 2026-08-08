// Track 4 / T4-B — the pure capacity derivation. Capacity truth is DERIVED from
// authoritative ContractAssignment consumption (ADR-0024 / A1), NEVER stored and
// NEVER mutated by pipeline. openings_available = max(capacity_balance, 0).
//
// G1 (§2): openings_reserved is structurally 0 and FULLY_RESERVED is UNREACHABLE
// — no Track-4 input produces it. This is ASSERTED by capacity-derivation.spec.ts
// (B-capacity-fully-reserved-unreachable), never by comment: an unenforced
// "unreachable" claim is the NULL=NULL / "consumes capacity" defect class.
//
// Completeness bound (§A3.2): consuming_count counts ONLY authoritative ACTIVE
// ContractAssignment rows. Residual legacy STARTED placements with no assignment
// are not counted — coverage is bounded by the materialised assignment
// population, asserted by the completeness proof.

export const CAPACITY_STATUSES = ['AVAILABLE', 'FULLY_RESERVED', 'FULLY_CONSUMED', 'OVER_CAPACITY'] as const;
export type CapacityStatus = (typeof CAPACITY_STATUSES)[number];

export type CapacityInput = {
  // Total openings on the requisition. Caller-supplied: placement does not own the
  // requisition (§4 — the declared consumer->placement edge carries openings IN,
  // there is no reverse read and no raw cross-schema SQL).
  readonly openings: number;
  // Count of AUTHORITATIVE consuming assignments (ACTIVE ContractAssignment) for
  // the requisition.
  readonly consuming_count: number;
};

export type CapacityProjection = {
  readonly openings: number;
  readonly openings_reserved: number; // structurally 0 (G1)
  readonly capacity_balance: number; // signed: openings - consuming_count
  readonly openings_available: number; // max(capacity_balance, 0)
  readonly capacity_status: CapacityStatus;
};

export function deriveCapacity(input: CapacityInput): CapacityProjection {
  const openings_reserved = 0; // G1 — no reservation authority in Track 4 v1
  const capacity_balance = input.openings - input.consuming_count;
  const openings_available = Math.max(capacity_balance, 0);
  const capacity_status = deriveStatus(capacity_balance);
  return { openings: input.openings, openings_reserved, capacity_balance, openings_available, capacity_status };
}

function deriveStatus(capacity_balance: number): CapacityStatus {
  if (capacity_balance < 0) return 'OVER_CAPACITY';
  if (capacity_balance === 0) return 'FULLY_CONSUMED';
  // Any positive balance — including partial consumption — is AVAILABLE.
  // FULLY_RESERVED is intentionally NEVER produced: openings_reserved is
  // structurally 0 (G1), so no reachable input maps here. This is enforced by
  // B-capacity-fully-reserved-unreachable, not by this comment.
  return 'AVAILABLE';
}
