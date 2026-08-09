import { apiClient } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { endPlacementAssignment, getPlacementAssignment } from './placement-api';
import type { ContractAssignmentView } from './types';

// API-layer characterization: the assignment read/end client methods issue the
// EXACT requests the merged backend serves (GET /v1/placements/{id}/assignment,
// POST /v1/placements/{id}/assignment/end with the authoritative end_reason
// taxonomy in the body). The component spec mocks this module at the domain
// seam; this spec pins the real request shaping against apiClient.

afterEach(() => {
  vi.restoreAllMocks();
});

const ACTIVE: ContractAssignmentView = {
  id: 'a1',
  placement_process_id: 'p1',
  submittal_id: 's1',
  requisition_id: 'r1',
  talent_record_id: 'tr1',
  started_at: '2026-08-01T09:30:00.000Z',
  provenance: 'FORWARD',
  lifecycle_state: 'ACTIVE',
  end_reason: null,
};

describe('placement-api — assignment read/end request shaping', () => {
  it('getPlacementAssignment issues GET /v1/placements/{id}/assignment (encoded id)', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ assignment: ACTIVE });
    const res = await getPlacementAssignment('p 1');
    expect(get).toHaveBeenCalledWith('/v1/placements/p%201/assignment');
    expect(res.assignment).toEqual(ACTIVE);
  });

  it('getPlacementAssignment surfaces a coherent { assignment: null }', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ assignment: null });
    const res = await getPlacementAssignment('p1');
    expect(res.assignment).toBeNull();
  });

  it('endPlacementAssignment POSTs the chosen reason in the authoritative taxonomy', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ ok: true });
    const res = await endPlacementAssignment('p1', 'WORKER_ENDED');
    expect(post).toHaveBeenCalledWith('/v1/placements/p1/assignment/end', {
      end_reason: 'WORKER_ENDED',
    });
    expect(res).toEqual({ ok: true });
  });

  it('endPlacementAssignment sends each taxonomy value verbatim (no collapse)', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ ok: true });
    for (const reason of ['COMPLETED', 'WORKER_ENDED', 'CLIENT_ENDED'] as const) {
      await endPlacementAssignment('p1', reason);
      expect(post).toHaveBeenLastCalledWith('/v1/placements/p1/assignment/end', {
        end_reason: reason,
      });
    }
  });
});
