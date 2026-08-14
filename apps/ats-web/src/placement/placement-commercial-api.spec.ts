import { apiClient } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cancelAssignmentCommercialRevision,
  createAssignmentCommercialRevision,
  listAssignmentCommercialRevisions,
} from './placement-api';

// Track 6 / T6-B4 §14 — API-layer characterization: the commercial-revision client methods
// issue the EXACT requests the B2/B3 backend serves. The component spec mocks this module at
// the domain seam; this spec pins the real request shaping against apiClient. B4 v1 create is
// Effective-now only — the request body carries NO effective_from (amendment §4).

afterEach(() => {
  vi.restoreAllMocks();
});

describe('placement-api — commercial revision request shaping', () => {
  it('listAssignmentCommercialRevisions GETs the series path (encoded id)', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ items: [] });
    const res = await listAssignmentCommercialRevisions('p 1');
    expect(get).toHaveBeenCalledWith('/v1/placements/p%201/assignment/commercials/revisions');
    expect(res.items).toEqual([]);
  });

  it('createAssignmentCommercialRevision POSTs the body verbatim and NEVER an effective_from', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ commercials: {} });
    const body = {
      pay_rate_amount: '90.00',
      bill_rate_amount: '150.00',
      currency: 'USD',
      rate_period: 'HOURLY',
      change_reason: 'rate bump',
    } as const;
    await createAssignmentCommercialRevision('p1', body);
    expect(post).toHaveBeenCalledWith('/v1/placements/p1/assignment/commercials/revisions', body);
    const sentBody = post.mock.calls[0][1] as Record<string, unknown>;
    expect('effective_from' in sentBody).toBe(false);
  });

  it('cancelAssignmentCommercialRevision POSTs the cancel path (encoded ids) + reason body', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ items: [] });
    await cancelAssignmentCommercialRevision('p 1', 'rev 9', { cancellation_reason_code: 'SCHEDULE_WITHDRAWN' });
    expect(post).toHaveBeenCalledWith(
      '/v1/placements/p%201/assignment/commercials/revisions/rev%209/cancel',
      { cancellation_reason_code: 'SCHEDULE_WITHDRAWN' },
    );
  });
});
