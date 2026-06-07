import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';

import { probeCompanyList } from './companies-api';

function mockJson(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('probeCompanyList — the new shared probe (S5c-3 ruling 5)', () => {
  it('returns ready + companies on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJson(200, {
        items: [
          { id: 'c-1', name: 'Acme', city: 'NYC', state: 'NY' },
          { id: 'c-2', name: 'Globex', city: null, state: null },
        ],
      }),
    );
    const out = await probeCompanyList();
    expect(out.state).toBe('ready');
    if (out.state === 'ready') {
      expect(out.companies).toHaveLength(2);
      expect(out.companies[0]?.name).toBe('Acme');
      expect(out.companies[1]?.city).toBeNull();
    }
  });

  it('returns forbidden on 403 (the picker fallback path)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJson(403, { error: { code: 'FORBIDDEN', message: 'no scope' } }),
    );
    const out = await probeCompanyList();
    expect(out).toEqual({ state: 'forbidden' });
  });

  it('rethrows on a non-403 error (a 500 is a real failure)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJson(500, { error: { code: 'INTERNAL', message: 'boom' } }),
    );
    await expect(probeCompanyList()).rejects.toBeInstanceOf(ApiError);
  });

  it('returns ready + empty array when items is omitted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockJson(200, {}));
    const out = await probeCompanyList();
    expect(out.state).toBe('ready');
    if (out.state === 'ready') {
      expect(out.companies).toHaveLength(0);
    }
  });
});
