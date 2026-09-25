import { describe, it, expect, beforeEach, vi } from 'vitest';

// PA-3 — the Company → Policies API client speaks domain DTOs over the nine read
// endpoints + three publishes. These proofs pin the exact routes + query encoding.
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@aramo/fe-foundation', () => ({ apiClient: { get, post } }));

import * as api from './policies-api';

describe('policies-api — endpoint URLs + query encoding', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({});
    post.mockReset().mockResolvedValue({});
  });

  it('client-submittal effective encodes company_id', async () => {
    await api.getClientSubmittalEffective('c1');
    expect(get).toHaveBeenCalledWith('/v1/client-submittal-policy/effective?company_id=c1');
  });

  it('effective with a null company (tenant-only) sends no query', async () => {
    await api.getClientSubmittalEffective(null);
    expect(get).toHaveBeenCalledWith('/v1/client-submittal-policy/effective');
  });

  it('effective encodes company_id + requisition_id', async () => {
    await api.getClientSubmittalEffective('c1', 'r1');
    expect(get).toHaveBeenCalledWith('/v1/client-submittal-policy/effective?company_id=c1&requisition_id=r1');
  });

  it('history encodes scope + scope_ref', async () => {
    await api.getClientSubmittalHistory('CLIENT', 'c1');
    expect(get).toHaveBeenCalledWith('/v1/client-submittal-policy/history?scope=CLIENT&scope_ref=c1');
  });

  it('history TENANT omits scope_ref', async () => {
    await api.getClientSubmittalHistory('TENANT', null);
    expect(get).toHaveBeenCalledWith('/v1/client-submittal-policy/history?scope=TENANT');
  });

  it('engagement effective route', async () => {
    await api.getEngagementEffective('c1');
    expect(get).toHaveBeenCalledWith('/v1/engagement/policy/effective?company_id=c1');
  });

  it('engagement history route', async () => {
    await api.getEngagementHistory('CLIENT', 'c1');
    expect(get).toHaveBeenCalledWith('/v1/engagement/policy/history?scope=CLIENT&scope_ref=c1');
  });

  it('pre-start layers route', async () => {
    await api.getPreStartLayers('c1');
    expect(get).toHaveBeenCalledWith('/v1/pre-start-requirement/layers?company_id=c1');
  });

  it('publish client-submittal posts the domain body', async () => {
    const body = { scope: 'CLIENT' as const, scope_ref: 'c1', version: 'v1', requirements: [] };
    await api.publishClientSubmittal(body);
    expect(post).toHaveBeenCalledWith('/v1/client-submittal-policy', body);
  });
});
