import { describe, expect, it, vi } from 'vitest';

import { RequisitionExistenceAdapter } from '../communications/requisition-existence.adapter';

// COMM-B5 — the composition-root binding for the comms-owned requisition
// existence port. It delegates to the requisition repository's tenant-safe
// status read (findStatusById), which returns null for a missing OR
// cross-tenant requisition — so a bogus/foreign `regarding` UUID is "does not
// exist" and the call is refused before any provider side effect.

describe('RequisitionExistenceAdapter', () => {
  it('returns true only when a tenant-scoped requisition status is found', async () => {
    const findStatusById = vi.fn().mockResolvedValue('open');
    const adapter = new RequisitionExistenceAdapter({ findStatusById } as never);

    await expect(adapter.exists('t1', 'req-1')).resolves.toBe(true);
    expect(findStatusById).toHaveBeenCalledWith({ tenant_id: 't1', id: 'req-1' });
  });

  it('returns false when the requisition is absent or belongs to another tenant', async () => {
    const findStatusById = vi.fn().mockResolvedValue(null);
    const adapter = new RequisitionExistenceAdapter({ findStatusById } as never);

    await expect(adapter.exists('t1', 'req-does-not-exist')).resolves.toBe(false);
    expect(findStatusById).toHaveBeenCalledWith({ tenant_id: 't1', id: 'req-does-not-exist' });
  });
});
