import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';

import {
  addManagementEdge,
  deleteManagementEdge,
  fetchManagementEdges,
  probeUserRoster,
} from './edges-api';

function mockJson(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('edges-api — endpoint wiring', () => {
  it('GET /v1/management/edges returns the items array', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockJson(200, { items: [] }));

    const out = await fetchManagementEdges();
    expect(out).toEqual({ items: [] });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/v1/management/edges');
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('POST /v1/management/edges sends the manager+report payload', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockJson(201, {
          id: 'e1',
          manager_user_id: 'u-a',
          report_user_id: 'u-b',
        }),
      );

    const out = await addManagementEdge({
      manager_user_id: 'u-a',
      report_user_id: 'u-b',
    });
    expect(out.id).toBe('e1');
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual({
      manager_user_id: 'u-a',
      report_user_id: 'u-b',
    });
  });

  it('DELETE /v1/management/edges/:id encodes the id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await deleteManagementEdge('e1');
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/v1/management/edges/e1');
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });
});

describe('probeUserRoster — the 403 fallback (ruling 6)', () => {
  it('returns ready+users on a 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJson(200, {
        items: [
          {
            user_id: 'u1',
            email: 'a@b.test',
            display_name: 'A',
            is_active: true,
            deactivated_at: null,
            site_id: null,
            role_keys: ['recruiter'],
          },
        ],
      }),
    );
    const out = await probeUserRoster();
    expect(out.state).toBe('ready');
    if (out.state === 'ready') {
      expect(out.users).toHaveLength(1);
    }
  });

  it('returns forbidden on a 403 (pure org:manage admin without user-manage scope)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJson(403, {
        error: { code: 'FORBIDDEN', message: 'no scope' },
      }),
    );
    const out = await probeUserRoster();
    expect(out).toEqual({ state: 'forbidden' });
  });

  it('rethrows on a non-403 error (a 500 is a real failure)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJson(500, { error: { code: 'INTERNAL', message: 'boom' } }),
    );
    await expect(probeUserRoster()).rejects.toBeInstanceOf(ApiError);
  });
});
