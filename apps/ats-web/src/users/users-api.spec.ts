import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchAssignableUsers, resolveUserNames } from './users-api';

// D-ORG-3 — the ATS people-directory reads that stayed product-owned after the
// user-management client moved to libs/org-admin-web.
function mockJson(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('users-api (ATS) — assignable users + name resolution', () => {
  it('GET /v1/tenant/assignable-users returns the minimal roster', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockJson(200, { items: [{ user_id: 'u1', display_name: 'A' }] }));
    const out = await fetchAssignableUsers();
    expect(out).toEqual([{ user_id: 'u1', display_name: 'A' }]);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/v1/tenant/assignable-users');
  });

  it('narrows the roster by company_id when given', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockJson(200, { items: [] }));
    await fetchAssignableUsers('c 1');
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/v1/tenant/assignable-users?company_id=c%201');
  });

  it('resolveUserNames batches the given ids and maps id → display_name (nulls dropped)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJson(200, { items: [{ user_id: 'u1', display_name: 'A' }, { user_id: 'u2', display_name: null }] }),
    );
    const out = await resolveUserNames(['u1', 'u2', 'u1', '']);
    expect(out).toEqual({ u1: 'A' });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/v1/tenant/users/directory?user_ids=u1%2Cu2');
  });

  it('resolveUserNames short-circuits an empty id set and degrades to {} on failure', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJson(500, { error: 'x' }));
    expect(await resolveUserNames([])).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await resolveUserNames(['u1'])).toEqual({});
  });
});
