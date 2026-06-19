import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assignUserToCompany,
  assignUserToRequisition,
  addTeamClient,
  fetchCompanyAssignments,
  fetchRequisitionAssignments,
  fetchTeamClients,
  removeTeamClient,
  unassignUserFromCompany,
  unassignUserFromRequisition,
} from './assignments-api';

function mockJson(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('assignments-api — D (company-assignments) endpoint wiring', () => {
  it('GET encodes the companyId', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockJson(200, { items: [] }));
    await fetchCompanyAssignments('c-1');
    expect(spy.mock.calls[0]?.[0]).toBe('/v1/companies/c-1/assignments');
  });

  it('POST sends the user_id body', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockJson(201, { id: 'a-1', user_id: 'u-1', company_id: 'c-1' }),
      );
    await assignUserToCompany({
      companyId: 'c-1',
      body: { user_id: 'u-1' },
    });
    expect(spy.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(spy.mock.calls[0]?.[1]?.body as string)).toEqual({
      user_id: 'u-1',
    });
  });

  it('DELETE encodes both companyId and userId', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await unassignUserFromCompany({ companyId: 'c-1', userId: 'u-1' });
    expect(spy.mock.calls[0]?.[0]).toBe('/v1/companies/c-1/assignments/u-1');
    expect(spy.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });
});

describe('assignments-api — E (team-clients) endpoint wiring', () => {
  it('GET encodes the teamId', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockJson(200, { items: [] }));
    await fetchTeamClients('t-1');
    expect(spy.mock.calls[0]?.[0]).toBe('/v1/teams/t-1/clients');
  });

  it('POST sends the company_id body', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockJson(201, { id: 'o-1', team_id: 't-1', company_id: 'c-1' }),
      );
    await addTeamClient({ teamId: 't-1', body: { company_id: 'c-1' } });
    expect(JSON.parse(spy.mock.calls[0]?.[1]?.body as string)).toEqual({
      company_id: 'c-1',
    });
  });

  it('DELETE encodes both teamId and companyId', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await removeTeamClient({ teamId: 't-1', companyId: 'c-1' });
    expect(spy.mock.calls[0]?.[0]).toBe('/v1/teams/t-1/clients/c-1');
  });
});

describe('assignments-api — F (requisition-assign) endpoint wiring', () => {
  it('GET encodes the requisitionId', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockJson(200, { items: [] }));
    await fetchRequisitionAssignments('r-1');
    expect(spy.mock.calls[0]?.[0]).toBe(
      '/v1/requisitions/r-1/assignments',
    );
  });

  it('POST sends the user_id body', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockJson(201, {
          id: 'ra-1',
          tenant_id: 't',
          requisition_id: 'r-1',
          user_id: 'u-1',
          assigned_at: '2026-01-01T00:00:00.000Z',
          assigned_by_id: null,
        }),
      );
    await assignUserToRequisition({
      requisitionId: 'r-1',
      body: { user_id: 'u-1' },
    });
    expect(JSON.parse(spy.mock.calls[0]?.[1]?.body as string)).toEqual({
      user_id: 'u-1',
    });
  });

  it('DELETE encodes both requisitionId and userId', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await unassignUserFromRequisition({
      requisitionId: 'r-1',
      userId: 'u-1',
    });
    expect(spy.mock.calls[0]?.[0]).toBe(
      '/v1/requisitions/r-1/assignments/u-1',
    );
  });
});
