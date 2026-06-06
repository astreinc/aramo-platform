import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';

import { D4aController } from '../lib/d4a.controller.js';
import type { ManagementEdgeService } from '../lib/management-edge.service.js';
import type { ManagementEdgeRow } from '../lib/management-edge.repository.js';
import type { TeamService } from '../lib/team.service.js';
import type {
  TeamMembershipRow,
  TeamRow,
} from '../lib/team.repository.js';

// Settings S5-BE2 — D4aController read endpoints.
//
// Reading A (PO-ratified): scope-gated tenant-wide — the reads MATCH the
// existing mutate authority. NO resolver call; the controller passes
// authContext.tenant_id to the service and returns whatever the service
// returns. The PROOF-LEVEL assertions:
//
//   (a) shape — each read returns { items: [...] }
//   (b) NO narrowing — the controller does NOT consult resolveVisibility
//       / VisibilityResolver / visible_client_ids; the service is called
//       with tenant_id ONLY (no actor sub for the visibility predicate);
//       the result is returned as-is (no filter pass).
//   (c) scope-gating — the @RequireScopes decorator chain is verified at
//       integration boot (AppModule); the unit slice verifies the
//       controller's own logic.
//   (d) cross-tenant — the per-tenant isolation lives in the WHERE
//       clause on the repo side; the controller's contribution is
//       passing authContext.tenant_id (NOT any body/query value).
//   (g) NO audit — reads emit no audit (no audit service injected).

const REQUEST_ID = 'rq-s5-be2-id-001';
const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const OTHER_TENANT_ID = '01900000-0000-7000-8000-0000000000ee';
const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';
const TEAM_ID = '01900000-0000-7000-8000-000000000100';
const OTHER_TEAM_ID = '01900000-0000-7000-8000-000000000101';

function makeAuthContext(
  tenant_id = TENANT_ID,
  sub = ACTOR_ID,
  scopes: string[] = ['org:manage', 'team:manage'],
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
  mgmt: { listAllForTenant: ReturnType<typeof vi.fn> };
  teams: {
    listAllTeamsForTenant: ReturnType<typeof vi.fn>;
    listMembersForTeam: ReturnType<typeof vi.fn>;
  };
  ctl: D4aController;
}

function makeMocks(): Mocks {
  const mgmt = { listAllForTenant: vi.fn() };
  const teams = {
    listAllTeamsForTenant: vi.fn(),
    listMembersForTeam: vi.fn(),
  };
  const ctl = new D4aController(
    mgmt as unknown as ManagementEdgeService,
    teams as unknown as TeamService,
  );
  return { mgmt, teams, ctl };
}

function makeEdge(overrides: Partial<ManagementEdgeRow> = {}): ManagementEdgeRow {
  return {
    id: '01900000-0000-7000-8000-0000000000e1',
    tenant_id: TENANT_ID,
    manager_user_id: '01900000-0000-7000-8000-0000000000a1',
    report_user_id: '01900000-0000-7000-8000-0000000000a2',
    created_at: new Date('2026-06-01T00:00:00Z'),
    created_by_id: ACTOR_ID,
    ...overrides,
  };
}

function makeTeam(overrides: Partial<TeamRow> = {}): TeamRow {
  return {
    id: TEAM_ID,
    tenant_id: TENANT_ID,
    name: 'AM Pod Alpha',
    owner_user_id: '01900000-0000-7000-8000-0000000000a1',
    is_active: true,
    created_at: new Date('2026-06-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

function makeMembership(
  overrides: Partial<TeamMembershipRow> = {},
): TeamMembershipRow {
  return {
    id: '01900000-0000-7000-8000-0000000000m1',
    tenant_id: TENANT_ID,
    team_id: TEAM_ID,
    user_id: '01900000-0000-7000-8000-0000000000a2',
    added_at: new Date('2026-06-01T00:00:00Z'),
    added_by_id: ACTOR_ID,
    ...overrides,
  };
}

describe('D4aController.listEdges — Cat-5 (a) (b) (d) (g)', () => {
  it('(a) returns { items: ManagementEdgeRow[] } from the service', async () => {
    const { ctl, mgmt } = makeMocks();
    const e1 = makeEdge();
    const e2 = makeEdge({
      id: '01900000-0000-7000-8000-0000000000e2',
      manager_user_id: '01900000-0000-7000-8000-0000000000a3',
    });
    mgmt.listAllForTenant.mockResolvedValue([e1, e2]);

    const result = await ctl.listEdges(makeAuthContext());

    expect(result).toEqual({ items: [e1, e2] });
  });

  it('(b) NO-narrowing — the service is called with tenant_id ONLY (no actor sub / no visibility predicate / no resolver)', async () => {
    const { ctl, mgmt } = makeMocks();
    mgmt.listAllForTenant.mockResolvedValue([]);

    await ctl.listEdges(makeAuthContext(TENANT_ID, ACTOR_ID));

    expect(mgmt.listAllForTenant).toHaveBeenCalledTimes(1);
    // The signature carries tenant_id ONLY — no actor_user_id, no
    // visibility context, no resolver. If a future change widens this
    // signature to take a VisibilityContext, this assertion fires and
    // surfaces the Reading-A breach.
    expect(mgmt.listAllForTenant).toHaveBeenCalledWith(TENANT_ID);
    const args = mgmt.listAllForTenant.mock.calls[0];
    expect(args).toEqual([TENANT_ID]);
  });

  it('(d) per-tenant isolation: tenant_id derives from authContext, NEVER OTHER_TENANT_ID', async () => {
    const { ctl, mgmt } = makeMocks();
    mgmt.listAllForTenant.mockResolvedValue([]);

    await ctl.listEdges(makeAuthContext(TENANT_ID));

    expect(mgmt.listAllForTenant).toHaveBeenCalledWith(TENANT_ID);
    expect(mgmt.listAllForTenant).not.toHaveBeenCalledWith(OTHER_TENANT_ID);
  });
});

describe('D4aController.listTeams — Cat-5 (a) (b) (d) — active+inactive both surface', () => {
  it('(a) returns { items: TeamRow[] } including active AND inactive teams', async () => {
    const { ctl, teams } = makeMocks();
    const active = makeTeam({ is_active: true });
    const inactive = makeTeam({
      id: OTHER_TEAM_ID,
      name: 'AM Pod Beta',
      is_active: false,
    });
    teams.listAllTeamsForTenant.mockResolvedValue([active, inactive]);

    const result = await ctl.listTeams(makeAuthContext());

    expect(result.items).toHaveLength(2);
    expect(result.items.map((t) => t.is_active)).toEqual([true, false]);
  });

  it('(b) NO-narrowing — the service is called with tenant_id ONLY', async () => {
    const { ctl, teams } = makeMocks();
    teams.listAllTeamsForTenant.mockResolvedValue([]);

    await ctl.listTeams(makeAuthContext());

    expect(teams.listAllTeamsForTenant).toHaveBeenCalledWith(TENANT_ID);
    expect(teams.listAllTeamsForTenant.mock.calls[0]).toEqual([TENANT_ID]);
  });
});

describe('D4aController.listTeamMembers — Cat-5 (a) (d) cross-tenant 404', () => {
  it('(a) returns { items: TeamMembershipRow[] } when the team exists in tenant', async () => {
    const { ctl, teams } = makeMocks();
    const m1 = makeMembership();
    const m2 = makeMembership({
      id: '01900000-0000-7000-8000-0000000000m2',
      user_id: '01900000-0000-7000-8000-0000000000a3',
    });
    teams.listMembersForTeam.mockResolvedValue([m1, m2]);

    const result = await ctl.listTeamMembers(
      makeAuthContext(),
      TEAM_ID,
      REQUEST_ID,
    );

    expect(result).toEqual({ items: [m1, m2] });
    expect(teams.listMembersForTeam).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      team_id: TEAM_ID,
      request_id: REQUEST_ID,
    });
  });

  it('(d) cross-tenant :teamId — service throws NOT_FOUND; controller propagates (existence-non-leak per S5-BE1)', async () => {
    const { ctl, teams } = makeMocks();
    teams.listMembersForTeam.mockRejectedValue(
      new AramoError('NOT_FOUND', 'Team not found in tenant', 404, {
        requestId: REQUEST_ID,
        details: { team_id: TEAM_ID },
      }),
    );

    await expect(
      ctl.listTeamMembers(makeAuthContext(), TEAM_ID, REQUEST_ID),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
      context: { details: { team_id: TEAM_ID } },
    });
  });

  it('per-tenant isolation: service called with authContext.tenant_id, NEVER cross-tenant', async () => {
    const { ctl, teams } = makeMocks();
    teams.listMembersForTeam.mockResolvedValue([]);

    await ctl.listTeamMembers(makeAuthContext(TENANT_ID), TEAM_ID, REQUEST_ID);

    const args = teams.listMembersForTeam.mock.calls[0]?.[0] as {
      tenant_id: string;
      team_id: string;
    };
    expect(args.tenant_id).toBe(TENANT_ID);
    expect(args.tenant_id).not.toBe(OTHER_TENANT_ID);
    expect(args.team_id).toBe(TEAM_ID);
  });
});
