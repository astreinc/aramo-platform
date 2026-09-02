import { describe, expect, it, vi } from 'vitest';
import { canTransition } from '@aramo/placement';

import { PlacementBlockReconciliationService } from '../../pre-start-requirement/placement-block-reconciliation.service.js';

// Lane 5 / L5-P4 (ruling P3) — BLOCKED as a governed projection of the requirement
// facts. The reconciliation transitions PRE_START <-> BLOCKED to match the blocker
// projection (a blocking requirement in FAILED); it is idempotent and never touches a
// placement past the pre-start phase. No separate blocker store (no duplicate truth).

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const PLACEMENT = '00000000-0000-0000-0000-0000000000bb';

function service(opts: { state: string | null; blocked: boolean }) {
  const transition = vi.fn().mockImplementation((input: { to: string }) =>
    Promise.resolve({ id: PLACEMENT, state: input.to }),
  );
  const findById = vi.fn().mockResolvedValue(opts.state === null ? null : { id: PLACEMENT, state: opts.state });
  const deriveBlockers = vi.fn().mockResolvedValue({
    placement_process_id: PLACEMENT,
    blocked: opts.blocked,
    failed_blocking: [],
  });
  const svc = new PlacementBlockReconciliationService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { findById, transition } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { deriveBlockers } as any,
  );
  return { svc, transition, findById, deriveBlockers };
}

describe('L5-P4 — PlacementBlockReconciliationService (projection of the blocker facts)', () => {
  it('PRE_START + a FAILED blocking requirement → transitions to BLOCKED', async () => {
    const { svc, transition } = service({ state: 'PRE_START', blocked: true });
    const r = await svc.reconcile(TENANT, PLACEMENT, 'r');
    expect(transition).toHaveBeenCalledOnce();
    expect(transition.mock.calls[0]?.[0]).toMatchObject({ to: 'BLOCKED' });
    expect(r?.state).toBe('BLOCKED');
  });

  it('BLOCKED + no FAILED blocking (resolved) → transitions back to PRE_START', async () => {
    const { svc, transition } = service({ state: 'BLOCKED', blocked: false });
    const r = await svc.reconcile(TENANT, PLACEMENT, 'r');
    expect(transition.mock.calls[0]?.[0]).toMatchObject({ to: 'PRE_START' });
    expect(r?.state).toBe('PRE_START');
  });

  it('PRE_START + no FAILED blocking → no-op (idempotent)', async () => {
    const { svc, transition } = service({ state: 'PRE_START', blocked: false });
    expect(await svc.reconcile(TENANT, PLACEMENT, 'r')).toBeNull();
    expect(transition).not.toHaveBeenCalled();
  });

  it('BLOCKED + still-FAILED blocking → no-op (idempotent)', async () => {
    const { svc, transition } = service({ state: 'BLOCKED', blocked: true });
    expect(await svc.reconcile(TENANT, PLACEMENT, 'r')).toBeNull();
    expect(transition).not.toHaveBeenCalled();
  });

  it('a placement past pre-start is never reconciled (projection edge is PRE_START<->BLOCKED only)', async () => {
    for (const state of ['READY_TO_START', 'STARTED', 'NO_SHOW', 'FELL_THROUGH']) {
      const { svc, transition, deriveBlockers } = service({ state, blocked: true });
      expect(await svc.reconcile(TENANT, PLACEMENT, 'r')).toBeNull();
      expect(transition).not.toHaveBeenCalled();
      // short-circuits BEFORE deriving the projection.
      expect(deriveBlockers).not.toHaveBeenCalled();
    }
  });

  it('an unknown placement is a no-op', async () => {
    const { svc, transition } = service({ state: null, blocked: true });
    expect(await svc.reconcile(TENANT, PLACEMENT, 'r')).toBeNull();
    expect(transition).not.toHaveBeenCalled();
  });

  // Ruling P3's edge rule — enforced by the placement lifecycle's own authority.
  it('BLOCKED → PRE_START is legal; BLOCKED → READY_TO_START is illegal (ruling P3)', () => {
    expect(canTransition('BLOCKED', 'PRE_START')).toBe(true);
    expect(canTransition('BLOCKED', 'READY_TO_START')).toBe(false);
  });
});
