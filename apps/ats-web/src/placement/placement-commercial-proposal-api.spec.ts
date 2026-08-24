import { apiClient } from '@aramo/fe-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decideCommercialProposal,
  getCommercialProposal,
  listCommercialProposals,
  proposeCommercialRevision,
  transitionCommercialProposal,
} from './placement-api';

// Slice #4 — API-layer characterization: the commercial-proposal client methods issue the
// EXACT requests the backend serves (correct verb, path with encoded ids, verbatim body).

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE = '/v1/placements/p%201/assignment/commercials/proposals';

describe('placement-api — commercial proposal request shaping', () => {
  it('proposeCommercialRevision POSTs the proposals path + body verbatim', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ proposal: {} });
    const body = {
      pay_rate_amount: '90.00',
      bill_rate_amount: '150.00',
      currency: 'USD',
      rate_period: 'HOURLY',
      reason: 'market adjustment',
    } as const;
    await proposeCommercialRevision('p 1', body);
    expect(post).toHaveBeenCalledWith(BASE, body);
  });

  it('listCommercialProposals GETs the proposals path (encoded id)', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ items: [] });
    const res = await listCommercialProposals('p 1');
    expect(get).toHaveBeenCalledWith(BASE);
    expect(res.items).toEqual([]);
  });

  it('getCommercialProposal GETs the item path (encoded ids)', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ proposal: null });
    await getCommercialProposal('p 1', 'prop 9');
    expect(get).toHaveBeenCalledWith(`${BASE}/prop%209`);
  });

  it('transitionCommercialProposal PATCHes the item path with { action }', async () => {
    const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({ proposal: {} });
    await transitionCommercialProposal('p 1', 'prop 9', 'submit');
    expect(patch).toHaveBeenCalledWith(`${BASE}/prop%209`, { action: 'submit' });
  });

  it('decideCommercialProposal POSTs the decision path with the evidence body verbatim', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ proposal: {} });
    const body = { action: 'client_approve', client_approval_source: 'EMAIL', client_reference: 'PO-1' } as const;
    await decideCommercialProposal('p 1', 'prop 9', body);
    expect(post).toHaveBeenCalledWith(`${BASE}/prop%209/decision`, body);
  });
});
