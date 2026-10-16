import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@aramo/fe-foundation', async (orig) => ({ ...(await orig<typeof import('@aramo/fe-foundation')>()), apiClient: api }));

import { getCommunicationCapabilities, resetCommunicationCapabilitiesCache } from './communications-api';

describe('getCommunicationCapabilities — one shared ask per session window', () => {
  afterEach(() => {
    resetCommunicationCapabilitiesCache();
    vi.useRealTimers();
    api.get.mockReset();
  });

  it('many Call buttons share one request, including the 409 not-configured answer', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('not configured'), { status: 409 }));
    const results = await Promise.allSettled([getCommunicationCapabilities(), getCommunicationCapabilities(), getCommunicationCapabilities()]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('asks again after the TTL so a newly connected provider is picked up', async () => {
    vi.useFakeTimers();
    api.get.mockResolvedValue({ provider_key: 'zoom_phone', capabilities: { voice: true } });
    await getCommunicationCapabilities();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await getCommunicationCapabilities();
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});
