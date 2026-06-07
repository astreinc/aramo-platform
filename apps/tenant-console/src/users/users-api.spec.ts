import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import {
  assignTenantUserRoles,
  disableTenantUser,
  fetchTenantUser,
  fetchTenantUsers,
  inviteTenantUser,
  probeFinancialsToggle,
} from './users-api';

function mockJson(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('users-api — endpoint wiring', () => {
  it('GET /v1/tenant/users returns the items array', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockJson(200, { items: [] }));

    const out = await fetchTenantUsers();
    expect(out).toEqual({ items: [] });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/v1/tenant/users');
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('GET /v1/tenant/users/:user_id returns the row', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockJson(200, {
          user_id: 'u1',
          email: 'a@b.test',
          display_name: null,
          is_active: true,
          deactivated_at: null,
          site_id: null,
          role_keys: ['recruiter'],
        }),
      );

    const out = await fetchTenantUser('u1');
    expect(out.user_id).toBe('u1');
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/v1/tenant/users/u1');
  });

  it('POST /v1/tenant/users/invitations sends the invite body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockJson(201, {
          user_id: 'u1',
          membership_id: 'm1',
          cognito_sub: 's1',
        }),
      );

    await inviteTenantUser({
      email: 'a@b.test',
      display_name: 'A',
      role_keys: ['recruiter'],
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      '/v1/tenant/users/invitations',
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual(
      {
        email: 'a@b.test',
        display_name: 'A',
        role_keys: ['recruiter'],
      },
    );
  });

  it('POST /v1/tenant/users/:user_id/disable omits reason when null', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockJson(200, {
          membership_id: 'm1',
          changed: true,
          already_disabled: false,
        }),
      );

    await disableTenantUser({ userId: 'u1', reason: null });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      '/v1/tenant/users/u1/disable',
    );
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual(
      {},
    );
  });

  it('POST /v1/tenant/users/:user_id/disable includes reason when provided', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockJson(200, {
          membership_id: 'm1',
          changed: true,
          already_disabled: false,
        }),
      );

    await disableTenantUser({ userId: 'u1', reason: 'left the team' });
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual(
      { reason: 'left the team' },
    );
  });

  it('PATCH /v1/tenant/users/:user_id/roles sends the role-set', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockJson(200, {
          membership_id: 'm1',
          before_role_keys: ['recruiter'],
          after_role_keys: ['finance'],
          added_role_keys: ['finance'],
          removed_role_keys: ['recruiter'],
        }),
      );

    await assignTenantUserRoles({
      userId: 'u1',
      body: { role_keys: ['finance'] },
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      '/v1/tenant/users/u1/roles',
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('PATCH');
  });
});

describe('probeFinancialsToggle — courtesy probe (ruling 4)', () => {
  it('returns known+enabled when the settings GET resolves with the toggle on', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJson(200, {
        'compensation.display_default': 'both',
        'audit.financials_enabled': true,
      }),
    );
    const out = await probeFinancialsToggle();
    expect(out).toEqual({ state: 'known', enabled: true });
  });

  it('returns known+disabled when the toggle is off', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJson(200, {
        'audit.financials_enabled': false,
      }),
    );
    const out = await probeFinancialsToggle();
    expect(out).toEqual({ state: 'known', enabled: false });
  });

  it('falls back to unknown on a 403 (pure user-manage admin without settings scope)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJson(403, {
        error: { code: 'FORBIDDEN', message: 'no scope' },
      }),
    );
    const out = await probeFinancialsToggle();
    expect(out).toEqual({ state: 'unknown' });
  });

  it('rethrows on a non-403 error (a 500 here is a real failure)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJson(500, { error: { code: 'INTERNAL', message: 'boom' } }),
    );
    await expect(probeFinancialsToggle()).rejects.toBeInstanceOf(ApiError);
  });

  it('falls back to unknown when the key is missing from the view', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJson(200, { 'compensation.display_default': 'both' }),
    );
    const out = await probeFinancialsToggle();
    expect(out).toEqual({ state: 'unknown' });
  });
});
