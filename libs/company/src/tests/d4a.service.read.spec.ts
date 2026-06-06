import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import type { IdentityAuditService } from '@aramo/identity';

import type { CompanyRepository } from '../lib/company.repository.js';
import { D4aCompanyService } from '../lib/d4a.service.js';
import type { TeamClientOwnershipRepository } from '../lib/team-client-ownership.repository.js';
import type { UserClientAssignmentRepository } from '../lib/user-client-assignment.repository.js';

// Settings S5-BE2 — D4aCompanyService read methods.
//
// Reading A (PO-ratified): scope-gated tenant-wide. NO resolver call.
// Cat-5 (d) + (e) + (f) — the existence precheck (404), the repo WHERE
// scoped to tenant, the §7.3 cross-schema rule preserved (no team-
// existence precheck in libs/company).

const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const OTHER_TENANT_ID = '01900000-0000-7000-8000-0000000000ee';
const COMPANY_ID = '01900000-0000-7000-8000-000000000200';
const TEAM_ID = '01900000-0000-7000-8000-000000000100';

interface ServiceUnderTest {
  service: D4aCompanyService;
  companyRepo: { findById: ReturnType<typeof vi.fn> };
  assignments: {
    findByCompany: ReturnType<typeof vi.fn>;
    findByPair: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    deleteByPair: ReturnType<typeof vi.fn>;
  };
  ownerships: {
    findByTeam: ReturnType<typeof vi.fn>;
    findByPair: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    deleteByPair: ReturnType<typeof vi.fn>;
  };
}

function makeService(): ServiceUnderTest {
  const companyRepo = { findById: vi.fn() };
  const assignments = {
    findByCompany: vi.fn(),
    findByPair: vi.fn(),
    create: vi.fn(),
    deleteByPair: vi.fn(),
  };
  const ownerships = {
    findByTeam: vi.fn(),
    findByPair: vi.fn(),
    create: vi.fn(),
    deleteByPair: vi.fn(),
  };
  const audit = {
    writeEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as IdentityAuditService;
  const service = new D4aCompanyService(
    companyRepo as unknown as CompanyRepository,
    assignments as unknown as UserClientAssignmentRepository,
    ownerships as unknown as TeamClientOwnershipRepository,
    audit,
  );
  return { service, companyRepo, assignments, ownerships };
}

describe('D4aCompanyService.listAssignmentsForCompany — Cat-5 (d) (f)', () => {
  it('(f) returns rows when company exists in tenant; calls assignments.findByCompany with { tenant_id, company_id }', async () => {
    const { service, companyRepo, assignments } = makeService();
    companyRepo.findById.mockResolvedValue({
      id: COMPANY_ID,
      tenant_id: TENANT_ID,
      name: 'Acme',
    });
    const rows = [
      {
        id: 'A1',
        tenant_id: TENANT_ID,
        user_id: 'u1',
        company_id: COMPANY_ID,
        assigned_at: new Date(),
        assigned_by_id: null,
      },
    ];
    assignments.findByCompany.mockResolvedValue(rows);

    const result = await service.listAssignmentsForCompany({
      tenant_id: TENANT_ID,
      company_id: COMPANY_ID,
      request_id: 'rq-1',
    });

    expect(result).toEqual(rows);
    expect(companyRepo.findById).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      id: COMPANY_ID,
    });
    expect(assignments.findByCompany).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      company_id: COMPANY_ID,
    });
  });

  it('(d) absent company in this tenant → 404 NOT_FOUND; assignments.findByCompany is NEVER called (no work past the gate)', async () => {
    const { service, companyRepo, assignments } = makeService();
    companyRepo.findById.mockResolvedValue(null);

    await expect(
      service.listAssignmentsForCompany({
        tenant_id: TENANT_ID,
        company_id: COMPANY_ID,
        request_id: 'rq-x',
      }),
    ).rejects.toBeInstanceOf(AramoError);
    await expect(
      service.listAssignmentsForCompany({
        tenant_id: TENANT_ID,
        company_id: COMPANY_ID,
        request_id: 'rq-x',
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
      context: { details: { company_id: COMPANY_ID } },
    });
    expect(assignments.findByCompany).not.toHaveBeenCalled();
  });

  it('(d) cross-tenant :companyId → 404 (companyRepo.findById is tenant-scoped; returns null for OTHER_TENANT_ID owner)', async () => {
    const { service, companyRepo } = makeService();
    // CompanyRepository.findById is tenant-scoped; a company belonging
    // to OTHER_TENANT_ID returns null when queried with TENANT_ID.
    companyRepo.findById.mockResolvedValue(null);

    await expect(
      service.listAssignmentsForCompany({
        tenant_id: TENANT_ID,
        company_id: COMPANY_ID,
        request_id: 'rq-cross',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(companyRepo.findById).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      id: COMPANY_ID,
    });
    expect(companyRepo.findById).not.toHaveBeenCalledWith({
      tenant_id: OTHER_TENANT_ID,
      id: COMPANY_ID,
    });
  });
});

describe('D4aCompanyService.listClientsForTeam — Cat-5 (§7.3 rule preserved)', () => {
  it('returns ownerships scoped to tenant + team — NO cross-schema team-existence precheck', async () => {
    const { service, companyRepo, ownerships } = makeService();
    const rows = [
      {
        id: 'B1',
        tenant_id: TENANT_ID,
        team_id: TEAM_ID,
        company_id: COMPANY_ID,
        assigned_at: new Date(),
        assigned_by_id: null,
      },
    ];
    ownerships.findByTeam.mockResolvedValue(rows);

    const result = await service.listClientsForTeam({
      tenant_id: TENANT_ID,
      team_id: TEAM_ID,
    });

    expect(result).toEqual(rows);
    expect(ownerships.findByTeam).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      team_id: TEAM_ID,
    });
    // §7.3 rule: no cross-schema Team existence lookup (Team lives in
    // identity; addClientOwnership has the same stance). The tenant_id
    // WHERE on TeamClientOwnership is the isolation.
    expect(companyRepo.findById).not.toHaveBeenCalled();
  });

  it('cross-tenant :teamId yields empty list (the tenant_id WHERE filters; no leak — indistinguishable from a tenant-local team with no clients)', async () => {
    const { service, ownerships } = makeService();
    ownerships.findByTeam.mockResolvedValue([]);

    const result = await service.listClientsForTeam({
      tenant_id: TENANT_ID,
      team_id: TEAM_ID,
    });

    expect(result).toEqual([]);
    // The repo received tenant_id; the cross-tenant value is never in
    // the WHERE.
    const args = ownerships.findByTeam.mock.calls[0]?.[0] as {
      tenant_id: string;
    };
    expect(args.tenant_id).toBe(TENANT_ID);
    expect(args.tenant_id).not.toBe(OTHER_TENANT_ID);
  });
});
