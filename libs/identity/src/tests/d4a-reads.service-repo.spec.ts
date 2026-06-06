import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import type { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import { ManagementEdgeRepository } from '../lib/management-edge.repository.js';
import { ManagementEdgeService } from '../lib/management-edge.service.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';
import { TeamRepository } from '../lib/team.repository.js';
import { TeamService } from '../lib/team.service.js';

// Settings S5-BE2 — D4a reads at the service + repo layers.
//
// What this proves (the directive §4 Cat-5 set):
//   (e) the 2 NEW repo methods scope to tenant_id ONLY (no other-tenant
//       value in the WHERE; Reading A — the scope IS the gate)
//   (f) the REUSED repo method findMembershipsForTeam was already
//       tenant-scoped — the service-layer existence precheck adds the
//       404 wrapper
//   service-layer: listMembersForTeam — team-existence precheck → 404
//       when cross-tenant or absent (S5-BE1 existence-non-leak)
//   service-layer: listAllForTenant + listAllTeamsForTenant — pure
//       pass-throughs (no resolver, no actor sub, no visibility)

const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const OTHER_TENANT_ID = '01900000-0000-7000-8000-0000000000ee';
const TEAM_ID = '01900000-0000-7000-8000-000000000100';

function makePrismaForEdges(findMany: ReturnType<typeof vi.fn>): PrismaService {
  return {
    managementEdge: { findMany },
  } as unknown as PrismaService;
}

function makePrismaForTeams(fns: {
  teamFindMany?: ReturnType<typeof vi.fn>;
  teamFindUnique?: ReturnType<typeof vi.fn>;
  membershipFindMany?: ReturnType<typeof vi.fn>;
}): PrismaService {
  return {
    team: {
      findMany: fns.teamFindMany ?? vi.fn(),
      findUnique: fns.teamFindUnique ?? vi.fn(),
    },
    teamMembership: {
      findMany: fns.membershipFindMany ?? vi.fn(),
    },
  } as unknown as PrismaService;
}

describe('ManagementEdgeRepository.findAllForTenant — Cat-5 (e)', () => {
  it('WHERE clause is { tenant_id } ONLY — no other-tenant value, no actor_sub, no visibility predicate', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new ManagementEdgeRepository(makePrismaForEdges(findMany));

    await repo.findAllForTenant(TENANT_ID);

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as {
      where: { tenant_id: string };
      orderBy: unknown;
    };
    expect(args.where).toEqual({ tenant_id: TENANT_ID });
    expect(args.where).not.toMatchObject({ tenant_id: OTHER_TENANT_ID });
    // Stable order for the S5c org-tree render.
    expect(args.orderBy).toEqual([
      { created_at: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('returns every row the WHERE matched (no in-memory filter pass)', async () => {
    const rows = [
      {
        id: 'e1',
        tenant_id: TENANT_ID,
        manager_user_id: 'u1',
        report_user_id: 'u2',
        created_at: new Date(),
        created_by_id: null,
      },
      {
        id: 'e2',
        tenant_id: TENANT_ID,
        manager_user_id: 'u1',
        report_user_id: 'u3',
        created_at: new Date(),
        created_by_id: null,
      },
    ];
    const findMany = vi.fn().mockResolvedValue(rows);
    const repo = new ManagementEdgeRepository(makePrismaForEdges(findMany));

    const result = await repo.findAllForTenant(TENANT_ID);

    expect(result).toHaveLength(2);
    expect(result).toEqual(rows);
  });
});

describe('TeamRepository.findAllTeamsForTenant — Cat-5 (e)', () => {
  it('WHERE clause is { tenant_id } ONLY — and returns BOTH active AND inactive teams', async () => {
    const rows = [
      {
        id: 't1',
        tenant_id: TENANT_ID,
        name: 'AM Pod Alpha',
        owner_user_id: 'u1',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: 't2',
        tenant_id: TENANT_ID,
        name: 'AM Pod Beta (retired)',
        owner_user_id: 'u2',
        is_active: false,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ];
    const teamFindMany = vi.fn().mockResolvedValue(rows);
    const repo = new TeamRepository(makePrismaForTeams({ teamFindMany }));

    const result = await repo.findAllTeamsForTenant(TENANT_ID);

    const args = teamFindMany.mock.calls[0]?.[0] as {
      where: { tenant_id: string };
      orderBy: unknown;
    };
    expect(args.where).toEqual({ tenant_id: TENANT_ID });
    // NO is_active filter — both states surface so the FE can render.
    expect(args.where).not.toMatchObject({ is_active: true });
    expect(args.where).not.toMatchObject({ is_active: false });
    expect(args.orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }]);
    expect(result.map((t) => t.is_active)).toEqual([true, false]);
  });
});

describe('TeamService.listMembersForTeam — service precheck + 404', () => {
  function makeService(prisma: PrismaService): TeamService {
    const repo = new TeamRepository(prisma);
    const audit = {
      writeEvent: vi.fn(),
    } as unknown as IdentityAuditService;
    return new TeamService(repo, audit);
  }

  it('returns memberships when the team exists in tenant', async () => {
    const memberships = [
      {
        id: 'm1',
        tenant_id: TENANT_ID,
        team_id: TEAM_ID,
        user_id: 'u1',
        added_at: new Date(),
        added_by_id: null,
      },
    ];
    const teamFindUnique = vi.fn().mockResolvedValue({
      id: TEAM_ID,
      tenant_id: TENANT_ID,
      name: 'AM Pod Alpha',
      owner_user_id: 'u0',
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const membershipFindMany = vi.fn().mockResolvedValue(memberships);
    const svc = makeService(
      makePrismaForTeams({ teamFindUnique, membershipFindMany }),
    );

    const result = await svc.listMembersForTeam({
      tenant_id: TENANT_ID,
      team_id: TEAM_ID,
      request_id: 'rq-1',
    });

    expect(result).toEqual(memberships);
    expect(membershipFindMany.mock.calls[0]?.[0]).toMatchObject({
      where: { tenant_id: TENANT_ID, team_id: TEAM_ID },
    });
  });

  it('cross-tenant :teamId → 404 NOT_FOUND (the existence-non-leak rule — the team exists in another tenant, findTeamById returns null because tenant_id mismatches)', async () => {
    const teamFindUnique = vi.fn().mockResolvedValue({
      id: TEAM_ID,
      tenant_id: OTHER_TENANT_ID, // belongs to a DIFFERENT tenant
      name: 'Other-Tenant Team',
      owner_user_id: 'u0',
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const membershipFindMany = vi.fn();
    const svc = makeService(
      makePrismaForTeams({ teamFindUnique, membershipFindMany }),
    );

    await expect(
      svc.listMembersForTeam({
        tenant_id: TENANT_ID,
        team_id: TEAM_ID,
        request_id: 'rq-x',
      }),
    ).rejects.toBeInstanceOf(AramoError);
    await expect(
      svc.listMembersForTeam({
        tenant_id: TENANT_ID,
        team_id: TEAM_ID,
        request_id: 'rq-x',
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
      context: { details: { team_id: TEAM_ID } },
    });
    // Crucial: the membership read is NEVER attempted when the team
    // doesn't exist in this tenant (no work done past the gate).
    expect(membershipFindMany).not.toHaveBeenCalled();
  });

  it('absent :teamId (no row at all) → 404 NOT_FOUND', async () => {
    const teamFindUnique = vi.fn().mockResolvedValue(null);
    const membershipFindMany = vi.fn();
    const svc = makeService(
      makePrismaForTeams({ teamFindUnique, membershipFindMany }),
    );

    await expect(
      svc.listMembersForTeam({
        tenant_id: TENANT_ID,
        team_id: TEAM_ID,
        request_id: 'rq-y',
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    expect(membershipFindMany).not.toHaveBeenCalled();
  });
});

describe('Service pass-throughs — listAllForTenant / listAllTeamsForTenant — Reading A no-narrowing', () => {
  it('ManagementEdgeService.listAllForTenant calls the repo with tenant_id ONLY', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new ManagementEdgeRepository(makePrismaForEdges(findMany));
    const audit = { writeEvent: vi.fn() } as unknown as IdentityAuditService;
    const svc = new ManagementEdgeService(repo, audit);

    await svc.listAllForTenant(TENANT_ID);

    const args = findMany.mock.calls[0]?.[0] as { where: { tenant_id: string } };
    expect(args.where).toEqual({ tenant_id: TENANT_ID });
  });

  it('TeamService.listAllTeamsForTenant calls the repo with tenant_id ONLY', async () => {
    const teamFindMany = vi.fn().mockResolvedValue([]);
    const repo = new TeamRepository(makePrismaForTeams({ teamFindMany }));
    const audit = { writeEvent: vi.fn() } as unknown as IdentityAuditService;
    const svc = new TeamService(repo, audit);

    await svc.listAllTeamsForTenant(TENANT_ID);

    const args = teamFindMany.mock.calls[0]?.[0] as { where: { tenant_id: string } };
    expect(args.where).toEqual({ tenant_id: TENANT_ID });
  });
});
