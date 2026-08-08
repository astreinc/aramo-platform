import { describe, expect, it } from 'vitest';

import { deriveCapacity, type CapacityStatus } from '../lib/capacity/capacity-derivation.js';

// Track 4 / T4-B — the pure capacity derivation boundaries (Directive §11):
//   consume        capacity_balance = openings - consuming_count (exactly once/each)
//   over-capacity  signed balance goes negative; openings_available = max(balance,0)
//   FULLY_RESERVED §2 B-capacity-fully-reserved-unreachable (plant -> RED names it)
//   completeness   residual (uncounted) rows do not consume; coverage is the count

describe('T4-B capacity derivation', () => {
  it('consume: capacity_balance = openings - consuming_count, openings_available follows', () => {
    // Non-vacuous: assert the exact balance at several consumption levels.
    expect(deriveCapacity({ openings: 3, consuming_count: 0 })).toMatchObject({
      capacity_balance: 3,
      openings_available: 3,
      capacity_status: 'AVAILABLE',
    });
    expect(deriveCapacity({ openings: 3, consuming_count: 1 })).toMatchObject({
      capacity_balance: 2,
      openings_available: 2,
      capacity_status: 'AVAILABLE',
    });
    expect(deriveCapacity({ openings: 3, consuming_count: 3 })).toMatchObject({
      capacity_balance: 0,
      openings_available: 0,
      capacity_status: 'FULLY_CONSUMED',
    });
  });

  it('over-capacity: signed balance goes negative while openings_available floors at 0', () => {
    const r = deriveCapacity({ openings: 2, consuming_count: 5 });
    expect(r.capacity_balance).toBe(-3); // signed, expresses the overage
    expect(r.openings_available).toBe(0); // max(balance, 0)
    expect(r.capacity_status).toBe('OVER_CAPACITY');
  });

  it('B-capacity-fully-reserved-unreachable: no reachable input yields FULLY_RESERVED and openings_reserved is always 0', () => {
    const produced = new Set<CapacityStatus>();
    for (let openings = 0; openings <= 12; openings++) {
      for (let consuming_count = 0; consuming_count <= 20; consuming_count++) {
        const r = deriveCapacity({ openings, consuming_count });
        produced.add(r.capacity_status);
        // G1 — reservation authority does not exist in Track 4 v1.
        expect(r.openings_reserved).toBe(0);
      }
    }
    // The state exists in the ratified enum but Track 4 supplies no derivation
    // that produces it. If this fails naming FULLY_RESERVED, a code path reached
    // it illegally (RED must NAME the state).
    expect([...produced].sort()).toEqual(['AVAILABLE', 'FULLY_CONSUMED', 'OVER_CAPACITY']);
    expect(produced.has('FULLY_RESERVED')).toBe(false);
  });

  it('completeness: an uncounted (residual) assignment does not consume — coverage is the count passed in', () => {
    // A legacy STARTED placement with no materialised ContractAssignment is not in
    // consuming_count, so it contributes nothing. Coverage is bounded by the
    // count supplied — the derivation is silent about the residual by construction.
    const covered = deriveCapacity({ openings: 5, consuming_count: 2 });
    expect(covered.capacity_balance).toBe(3); // only the 2 covered assignments consume
    const noneCovered = deriveCapacity({ openings: 5, consuming_count: 0 });
    expect(noneCovered.capacity_balance).toBe(5); // residual-only requisition reads full
    expect(noneCovered.capacity_status).toBe('AVAILABLE');
  });
});
