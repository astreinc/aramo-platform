import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addMember,
  createTeam,
  fetchTeamMembers,
  fetchTeams,
  removeMember,
} from './teams-api';

function mockJson(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('teams-api — endpoint wiring', () => {
  it('GET /v1/teams returns the items array', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockJson(200, { items: [] }));
    await fetchTeams();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/v1/teams');
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('GET /v1/teams/:teamId/members encodes the team id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockJson(200, { items: [] }));
    await fetchTeamMembers('t1');
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/v1/teams/t1/members');
  });

  it('POST /v1/teams sends name + owner_user_id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockJson(201, {
          id: 't1',
          name: 'Alpha',
          owner_user_id: 'u-1',
          is_active: true,
        }),
      );
    await createTeam({ name: 'Alpha', owner_user_id: 'u-1' });
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual({
      name: 'Alpha',
      owner_user_id: 'u-1',
    });
  });

  it('POST /v1/teams/:teamId/members sends the user_id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockJson(201, { id: 'm1', team_id: 't1', user_id: 'u-1' }),
      );
    await addMember({ teamId: 't1', body: { user_id: 'u-1' } });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/v1/teams/t1/members');
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toEqual({
      user_id: 'u-1',
    });
  });

  it('DELETE /v1/teams/:teamId/members/:userId encodes both ids', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await removeMember({ teamId: 't1', userId: 'u-1' });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/v1/teams/t1/members/u-1');
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });
});
