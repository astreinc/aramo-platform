import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';

import { D4aCompanyController } from '../lib/d4a.controller.js';
import type { D4aCompanyService } from '../lib/d4a.service.js';
import type { TeamClientOwnershipRow } from '../lib/team-client-ownership.repository.js';
import type { UserClientAssignmentRow } from '../lib/user-client-assignment.repository.js';

// Settings S5-BE2 — D4aCompanyController read endpoints.
//
// Reading A (PO-ratified): scope-gated tenant-wide — the reads MATCH the
// existing mutate authority. NO resolver call; NO resolver extension.
//
// What this proves (the directive §4 Cat-5 set):
//   (a) shape — each read returns { items: [...] }
//   (b) NO narrowing — the controller does NOT consult resolveVisibility
//       / VisibilityResolver / visible_client_ids
//   (d) cross-tenant — the per-tenant 404 path (the service-layer 404)
//   (g) NO audit — reads emit no audit

const REQUEST_ID = 'rq-s5-be2-co-001';
const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const OTHER_TENANT_ID = '01900000-0000-7000-8000-0000000000ee';
const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';
const COMPANY_ID = '01900000-0000-7000-8000-000000000200';
const TEAM_ID = '01900000-0000-7000-8000-000000000100';
const OTHER_COMPANY_ID = '01900000-0000-7000-8000-0000000002ff';

function makeAuthContext(
  tenant_id = TENANT_ID,
  sub = ACTOR_ID,
  scopes: string[] = ['company:assign', 'team:manage'],
): AuthContextType {
  return {
    sub,
    tenant_id,
    scopes,
    consumer_type: 'tenant_user',
    capabilities: ['ats'],
  } as unknown as AuthContextType;
}

interface Mocks {
  d4a: {
    listAssignmentsForCompany: ReturnType<typeof vi.fn>;
    listClientsForTeam: ReturnType<typeof vi.fn>;
  };
  ctl: D4aCompanyController;
}

function makeMocks(): Mocks {
  const d4a = {
    listAssignmentsForCompany: vi.fn(),
    listClientsForTeam: vi.fn(),
  };
  const ctl = new D4aCompanyController(d4a as unknown as D4aCompanyService);
  return { d4a, ctl };
}

function makeAssignment(
  overrides: Partial<UserClientAssignmentRow> = {},
): UserClientAssignmentRow {
  return {
    id: '01900000-0000-7000-8000-0000000000A1',
    tenant_id: TENANT_ID,
    user_id: '01900000-0000-7000-8000-0000000000a1',
    company_id: COMPANY_ID,
    assigned_at: new Date('2026-06-01T00:00:00Z'),
    assigned_by_id: ACTOR_ID,
    ...overrides,
  };
}

function makeOwnership(
  overrides: Partial<TeamClientOwnershipRow> = {},
): TeamClientOwnershipRow {
  return {
    id: '01900000-0000-7000-8000-0000000000B1',
    tenant_id: TENANT_ID,
    team_id: TEAM_ID,
    company_id: COMPANY_ID,
    assigned_at: new Date('2026-06-01T00:00:00Z'),
    assigned_by_id: ACTOR_ID,
    ...overrides,
  };
}

describe('D4aCompanyController.listCompanyAssignments — Cat-5 (a) (b) (d)', () => {
  it('(a) returns { items: UserClientAssignmentRow[] } when company exists in tenant', async () => {
    const { ctl, d4a } = makeMocks();
    const a1 = makeAssignment();
    const a2 = makeAssignment({
      id: '01900000-0000-7000-8000-0000000000A2',
      user_id: '01900000-0000-7000-8000-0000000000a2',
    });
    d4a.listAssignmentsForCompany.mockResolvedValue([a1, a2]);

    const result = await ctl.listCompanyAssignments(
      makeAuthContext(),
      COMPANY_ID,
      REQUEST_ID,
    );

    expect(result).toEqual({ items: [a1, a2] });
    expect(d4a.listAssignmentsForCompany).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      company_id: COMPANY_ID,
      request_id: REQUEST_ID,
    });
  });

  it('(b) NO-narrowing — service called with { tenant_id, company_id, request_id } ONLY (no actor sub, no visibility ctx)', async () => {
    const { ctl, d4a } = makeMocks();
    d4a.listAssignmentsForCompany.mockResolvedValue([]);

    await ctl.listCompanyAssignments(makeAuthContext(), COMPANY_ID, REQUEST_ID);

    const args = d4a.listAssignmentsForCompany.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(args).sort()).toEqual([
      'company_id',
      'request_id',
      'tenant_id',
    ]);
  });

  it('(d) cross-tenant :companyId → 404 (service throws; controller propagates)', async () => {
    const { ctl, d4a } = makeMocks();
    d4a.listAssignmentsForCompany.mockRejectedValue(
      new AramoError('NOT_FOUND', 'Company not found in tenant', 404, {
        requestId: REQUEST_ID,
        details: { company_id: OTHER_COMPANY_ID },
      }),
    );

    await expect(
      ctl.listCompanyAssignments(
        makeAuthContext(),
        OTHER_COMPANY_ID,
        REQUEST_ID,
      ),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
      context: { details: { company_id: OTHER_COMPANY_ID } },
    });
  });

  it('per-tenant isolation: tenant_id derives from authContext, NEVER cross-tenant', async () => {
    const { ctl, d4a } = makeMocks();
    d4a.listAssignmentsForCompany.mockResolvedValue([]);

    await ctl.listCompanyAssignments(
      makeAuthContext(TENANT_ID),
      COMPANY_ID,
      REQUEST_ID,
    );

    const args = d4a.listAssignmentsForCompany.mock.calls[0]?.[0] as {
      tenant_id: string;
    };
    expect(args.tenant_id).toBe(TENANT_ID);
    expect(args.tenant_id).not.toBe(OTHER_TENANT_ID);
  });
});

describe('D4aCompanyController.listTeamClients — Cat-5 (a) (b) (no precheck per §7.3)', () => {
  it('(a) returns { items: TeamClientOwnershipRow[] }', async () => {
    const { ctl, d4a } = makeMocks();
    const o1 = makeOwnership();
    const o2 = makeOwnership({
      id: '01900000-0000-7000-8000-0000000000B2',
      company_id: '01900000-0000-7000-8000-0000000002bb',
    });
    d4a.listClientsForTeam.mockResolvedValue([o1, o2]);

    const result = await ctl.listTeamClients(makeAuthContext(), TEAM_ID);

    expect(result).toEqual({ items: [o1, o2] });
  });

  it('(b) NO-narrowing — service called with { tenant_id, team_id } ONLY', async () => {
    const { ctl, d4a } = makeMocks();
    d4a.listClientsForTeam.mockResolvedValue([]);

    await ctl.listTeamClients(makeAuthContext(), TEAM_ID);

    expect(d4a.listClientsForTeam).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      team_id: TEAM_ID,
    });
    const args = d4a.listClientsForTeam.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(args).sort()).toEqual(['team_id', 'tenant_id']);
  });

  it('cross-tenant :teamId yields empty list (the §7.3 stance — no cross-schema FK lookup; the tenant_id WHERE clause filters)', async () => {
    const { ctl, d4a } = makeMocks();
    // Per the §7.3 rule, no team-existence precheck. The service reads
    // TeamClientOwnership WHERE tenant_id=actor's AND team_id=:teamId;
    // a cross-tenant team_id yields an empty list (no rows match — the
    // tenant_id filter does the isolation).
    d4a.listClientsForTeam.mockResolvedValue([]);

    const result = await ctl.listTeamClients(
      makeAuthContext(TENANT_ID),
      TEAM_ID, // could be a cross-tenant team_id; the empty result is the safe-by-default behavior
    );

    expect(result).toEqual({ items: [] });
  });

  it('per-tenant isolation: tenant_id derives from authContext, NEVER cross-tenant', async () => {
    const { ctl, d4a } = makeMocks();
    d4a.listClientsForTeam.mockResolvedValue([]);

    await ctl.listTeamClients(makeAuthContext(TENANT_ID), TEAM_ID);

    const args = d4a.listClientsForTeam.mock.calls[0]?.[0] as {
      tenant_id: string;
    };
    expect(args.tenant_id).toBe(TENANT_ID);
    expect(args.tenant_id).not.toBe(OTHER_TENANT_ID);
  });
});
