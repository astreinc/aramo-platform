import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AuthContextType } from '@aramo/auth';
import type { VisibilityContextShape } from '@aramo/common';

import { CompanyController } from '../lib/company.controller.js';
import { CompanyRepository } from '../lib/company.repository.js';
import { CompanyDepartmentRepository } from '../lib/company-department.repository.js';
import type { CompanyBillingContactValidator } from '../lib/billing-contact-validator.port.js';

// CONTACTS-1 W-2 — company + department write-visibility parity, and the
// SD-6 billing-contact port. A company outside the actor's resolved D4b
// visibility is a 404 on every mutation (identical to the invisible read);
// a visible company and a see_all_company actor are allowed.

const REQUEST_ID = 'rq-contacts-1-w2-001';
const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';
const VISIBLE = '01900000-0000-7000-8000-000000000201';
const INVISIBLE = '01900000-0000-7000-8000-000000000299';
const DEPT_ID = '01900000-0000-7000-8000-000000000301';
const CONTACT_ID = '01900000-0000-7000-8000-000000000401';
const OTHER_CONTACT_ID = '01900000-0000-7000-8000-000000000402';

const INVISIBLE_READ_404 = {
  code: 'NOT_FOUND',
  statusCode: 404,
  message: 'Company not found in tenant (or not visible to actor)',
};

function scoped(): VisibilityContextShape {
  return {
    tenant_id: TENANT_ID,
    actor_user_id: ACTOR_ID,
    see_all_company: false,
    see_all_requisition: false,
    visible_client_ids: new Set([VISIBLE]),
  };
}

function seeAll(): VisibilityContextShape {
  return {
    tenant_id: TENANT_ID,
    actor_user_id: ACTOR_ID,
    see_all_company: true,
    see_all_requisition: false,
    visible_client_ids: null,
  };
}

function companyRow(id: string, billing_contact_id: string | null = null) {
  const d = new Date('2026-06-01T00:00:00Z');
  return {
    id,
    tenant_id: TENANT_ID,
    name: 'Acme',
    billing_contact_id,
    created_at: d,
    updated_at: d,
    last_activity_at: null,
    next_action_at: null,
    default_contract_markup_pct: null,
    default_perm_fee_pct: null,
    relationships: [],
  };
}

function deptRow(company_id: string) {
  const d = new Date('2026-06-01T00:00:00Z');
  return {
    id: DEPT_ID,
    tenant_id: TENANT_ID,
    site_id: null,
    company_id,
    name: 'Engineering',
    created_at: d,
    updated_at: d,
  };
}

function mockPrisma(existingBilling: string | null = null) {
  const company = {
    findFirst: vi
      .fn()
      .mockImplementation(async (a: { where: { id: string } }) =>
        companyRow(a.where.id, existingBilling),
      ),
    update: vi
      .fn()
      .mockImplementation(async (a: { where: { id: string } }) => companyRow(a.where.id)),
    delete: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue(companyRow(VISIBLE)),
  };
  const companyDepartment = {
    findFirst: vi
      .fn()
      .mockImplementation(async (a: { where: { company_id: string } }) =>
        deptRow(a.where.company_id),
      ),
    update: vi.fn().mockResolvedValue(deptRow(VISIBLE)),
    delete: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue(deptRow(VISIBLE)),
  };
  return { company, companyDepartment };
}

function makeValidator(): CompanyBillingContactValidator & {
  assertLinkable: ReturnType<typeof vi.fn>;
} {
  return { assertLinkable: vi.fn().mockResolvedValue(undefined) };
}

describe('CONTACTS-1 W-2 — CompanyRepository.update / delete visibility', () => {
  it('update: invisible company → 404 identical to the invisible read; no read, no write', async () => {
    const prisma = mockPrisma();
    const repo = new CompanyRepository(prisma as never);
    await expect(
      repo.update({
        tenant_id: TENANT_ID,
        id: INVISIBLE,
        input: { name: 'x' },
        requestId: REQUEST_ID,
        scopes: [],
        visibility: scoped(),
      }),
    ).rejects.toMatchObject(INVISIBLE_READ_404);
    expect(prisma.company.findFirst).not.toHaveBeenCalled();
    expect(prisma.company.update).not.toHaveBeenCalled();
  });

  it('update: visible company → written', async () => {
    const prisma = mockPrisma();
    const repo = new CompanyRepository(prisma as never);
    const view = await repo.update({
      tenant_id: TENANT_ID,
      id: VISIBLE,
      input: { name: 'x' },
      requestId: REQUEST_ID,
      scopes: [],
      visibility: scoped(),
    });
    expect(view.id).toBe(VISIBLE);
    expect(prisma.company.update).toHaveBeenCalledTimes(1);
  });

  it('update: see_all_company → written even when not in any assignment set', async () => {
    const prisma = mockPrisma();
    const repo = new CompanyRepository(prisma as never);
    await repo.update({
      tenant_id: TENANT_ID,
      id: INVISIBLE,
      input: { name: 'x' },
      requestId: REQUEST_ID,
      scopes: [],
      visibility: seeAll(),
    });
    expect(prisma.company.update).toHaveBeenCalledTimes(1);
  });

  it('update: visible but missing company → the same 404', async () => {
    const prisma = mockPrisma();
    prisma.company.findFirst.mockResolvedValueOnce(null);
    const repo = new CompanyRepository(prisma as never);
    await expect(
      repo.update({
        tenant_id: TENANT_ID,
        id: VISIBLE,
        input: { name: 'x' },
        requestId: REQUEST_ID,
        scopes: [],
        visibility: scoped(),
      }),
    ).rejects.toMatchObject(INVISIBLE_READ_404);
  });

  it('delete: invisible company → 404; no delete', async () => {
    const prisma = mockPrisma();
    const repo = new CompanyRepository(prisma as never);
    await expect(
      repo.delete({
        tenant_id: TENANT_ID,
        id: INVISIBLE,
        requestId: REQUEST_ID,
        visibility: scoped(),
      }),
    ).rejects.toMatchObject(INVISIBLE_READ_404);
    expect(prisma.company.delete).not.toHaveBeenCalled();
  });

  it('delete: visible company → deleted (hard delete unchanged)', async () => {
    const prisma = mockPrisma();
    const repo = new CompanyRepository(prisma as never);
    await repo.delete({
      tenant_id: TENANT_ID,
      id: VISIBLE,
      requestId: REQUEST_ID,
      visibility: scoped(),
    });
    expect(prisma.company.delete).toHaveBeenCalledWith({ where: { id: VISIBLE } });
  });

  it('delete: see_all_company → deleted', async () => {
    const prisma = mockPrisma();
    const repo = new CompanyRepository(prisma as never);
    await repo.delete({
      tenant_id: TENANT_ID,
      id: INVISIBLE,
      requestId: REQUEST_ID,
      visibility: seeAll(),
    });
    expect(prisma.company.delete).toHaveBeenCalledWith({ where: { id: INVISIBLE } });
  });
});

describe('CONTACTS-1 W-2 — CompanyDepartmentRepository mutations visibility', () => {
  const DEPT_404 = { code: 'NOT_FOUND', statusCode: 404 };

  it('create: invisible parent → the missing-parent 404; no write', async () => {
    const prisma = mockPrisma();
    const repo = new CompanyDepartmentRepository(prisma as never);
    await expect(
      repo.create({
        tenant_id: TENANT_ID,
        company_id: INVISIBLE,
        input: { name: 'Eng' },
        requestId: REQUEST_ID,
        visibility: scoped(),
      }),
    ).rejects.toMatchObject({ ...DEPT_404, message: 'Company not found in tenant' });
    expect(prisma.companyDepartment.create).not.toHaveBeenCalled();
  });

  it('create: visible parent → created; see_all → created', async () => {
    const prisma = mockPrisma();
    const repo = new CompanyDepartmentRepository(prisma as never);
    await repo.create({
      tenant_id: TENANT_ID,
      company_id: VISIBLE,
      input: { name: 'Eng' },
      requestId: REQUEST_ID,
      visibility: scoped(),
    });
    await repo.create({
      tenant_id: TENANT_ID,
      company_id: INVISIBLE,
      input: { name: 'Eng' },
      requestId: REQUEST_ID,
      visibility: seeAll(),
    });
    expect(prisma.companyDepartment.create).toHaveBeenCalledTimes(2);
  });

  it('update: invisible parent → the missing-department 404; no write', async () => {
    const prisma = mockPrisma();
    const repo = new CompanyDepartmentRepository(prisma as never);
    await expect(
      repo.update({
        tenant_id: TENANT_ID,
        company_id: INVISIBLE,
        id: DEPT_ID,
        input: { name: 'x' },
        requestId: REQUEST_ID,
        visibility: scoped(),
      }),
    ).rejects.toMatchObject({ ...DEPT_404, message: 'CompanyDepartment not found in tenant' });
    expect(prisma.companyDepartment.findFirst).not.toHaveBeenCalled();
    expect(prisma.companyDepartment.update).not.toHaveBeenCalled();
  });

  it('update: visible parent → written; see_all → written', async () => {
    const prisma = mockPrisma();
    const repo = new CompanyDepartmentRepository(prisma as never);
    for (const [company_id, visibility] of [
      [VISIBLE, scoped()],
      [INVISIBLE, seeAll()],
    ] as const) {
      await repo.update({
        tenant_id: TENANT_ID,
        company_id,
        id: DEPT_ID,
        input: { name: 'x' },
        requestId: REQUEST_ID,
        visibility,
      });
    }
    expect(prisma.companyDepartment.update).toHaveBeenCalledTimes(2);
  });

  it('delete: invisible parent → 404; visible → deleted; see_all → deleted', async () => {
    const prisma = mockPrisma();
    const repo = new CompanyDepartmentRepository(prisma as never);
    await expect(
      repo.delete({
        tenant_id: TENANT_ID,
        company_id: INVISIBLE,
        id: DEPT_ID,
        requestId: REQUEST_ID,
        visibility: scoped(),
      }),
    ).rejects.toMatchObject({ ...DEPT_404, message: 'CompanyDepartment not found in tenant' });
    expect(prisma.companyDepartment.delete).not.toHaveBeenCalled();
    await repo.delete({
      tenant_id: TENANT_ID,
      company_id: VISIBLE,
      id: DEPT_ID,
      requestId: REQUEST_ID,
      visibility: scoped(),
    });
    await repo.delete({
      tenant_id: TENANT_ID,
      company_id: INVISIBLE,
      id: DEPT_ID,
      requestId: REQUEST_ID,
      visibility: seeAll(),
    });
    expect(prisma.companyDepartment.delete).toHaveBeenCalledTimes(2);
  });
});

describe('CONTACTS-1 W-2 — CompanyController threads the resolved visibility', () => {
  function makeAuth(): AuthContextType {
    return {
      sub: ACTOR_ID,
      tenant_id: TENANT_ID,
      scopes: ['company:edit', 'company:delete', 'company:create'],
    } as unknown as AuthContextType;
  }
  function makeReq(v: VisibilityContextShape): Request & {
    resolveVisibility: ReturnType<typeof vi.fn>;
  } {
    return { resolveVisibility: vi.fn().mockResolvedValue(v) } as never;
  }
  function makeCtl() {
    const companyRepo = {
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const deptRepo = {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const ctl = new CompanyController(companyRepo as never, deptRepo as never);
    return { ctl, companyRepo, deptRepo };
  }

  it('every company + department mutation resolves visibility and passes it to the repo', async () => {
    const { ctl, companyRepo, deptRepo } = makeCtl();
    const v = scoped();
    const req = makeReq(v);
    await ctl.update(makeAuth(), VISIBLE, { name: 'x' }, REQUEST_ID, req);
    await ctl.delete(makeAuth(), VISIBLE, REQUEST_ID, req);
    await ctl.createDepartment(makeAuth(), VISIBLE, { name: 'x' }, REQUEST_ID, req);
    await ctl.updateDepartment(makeAuth(), VISIBLE, DEPT_ID, { name: 'x' }, REQUEST_ID, req);
    await ctl.deleteDepartment(makeAuth(), VISIBLE, DEPT_ID, REQUEST_ID, req);
    expect(req.resolveVisibility).toHaveBeenCalledTimes(5);
    for (const fn of [
      companyRepo.update,
      companyRepo.delete,
      deptRepo.create,
      deptRepo.update,
      deptRepo.delete,
    ]) {
      expect(fn).toHaveBeenCalledWith(expect.objectContaining({ visibility: v }));
    }
  });
});

describe('CONTACTS-1 SD-6 — COMPANY_BILLING_CONTACT_VALIDATOR on update', () => {
  function update(repo: CompanyRepository, billing_contact_id: string | null | undefined) {
    return repo.update({
      tenant_id: TENANT_ID,
      id: VISIBLE,
      input: billing_contact_id === undefined ? { name: 'x' } : { billing_contact_id },
      requestId: REQUEST_ID,
      scopes: [],
      visibility: scoped(),
    });
  }

  it('new non-null billing_contact_id → validator invoked with the company being updated', async () => {
    const prisma = mockPrisma();
    const validator = makeValidator();
    const repo = new CompanyRepository(prisma as never, validator);
    await update(repo, CONTACT_ID);
    expect(validator.assertLinkable).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      contact_id: CONTACT_ID,
      company_id: VISIBLE,
      requestId: REQUEST_ID,
    });
    expect(prisma.company.update).toHaveBeenCalledTimes(1);
  });

  it('validator refusal → no write', async () => {
    const prisma = mockPrisma();
    const validator = makeValidator();
    validator.assertLinkable.mockRejectedValueOnce(
      Object.assign(new Error('deleted'), { code: 'CONTACT_DELETED', statusCode: 422 }),
    );
    const repo = new CompanyRepository(prisma as never, validator);
    await expect(update(repo, CONTACT_ID)).rejects.toMatchObject({
      code: 'CONTACT_DELETED',
    });
    expect(prisma.company.update).not.toHaveBeenCalled();
  });

  it('null (clear), absent, and unchanged billing_contact_id → validator not invoked', async () => {
    const prisma = mockPrisma(OTHER_CONTACT_ID);
    const validator = makeValidator();
    const repo = new CompanyRepository(prisma as never, validator);
    await update(repo, null);
    await update(repo, undefined);
    await update(repo, OTHER_CONTACT_ID);
    expect(validator.assertLinkable).not.toHaveBeenCalled();
    expect(prisma.company.update).toHaveBeenCalledTimes(3);
  });

  it('invisible company → 404 before the validator runs', async () => {
    const prisma = mockPrisma();
    const validator = makeValidator();
    const repo = new CompanyRepository(prisma as never, validator);
    await expect(
      repo.update({
        tenant_id: TENANT_ID,
        id: INVISIBLE,
        input: { billing_contact_id: CONTACT_ID },
        requestId: REQUEST_ID,
        scopes: [],
        visibility: scoped(),
      }),
    ).rejects.toMatchObject(INVISIBLE_READ_404);
    expect(validator.assertLinkable).not.toHaveBeenCalled();
  });

  it('no adapter bound (@Optional) → update proceeds without a link check', async () => {
    const prisma = mockPrisma();
    const repo = new CompanyRepository(prisma as never);
    await update(repo, CONTACT_ID);
    expect(prisma.company.update).toHaveBeenCalledTimes(1);
  });
});

describe('CONTACTS-1 SD-6 — billing_contact_id on create', () => {
  it('non-null billing_contact_id → 422 VALIDATION_ERROR; no write; validator not consulted', async () => {
    const prisma = mockPrisma();
    const validator = makeValidator();
    const repo = new CompanyRepository(prisma as never, validator);
    await expect(
      repo.create({
        tenant_id: TENANT_ID,
        entered_by_id: ACTOR_ID,
        input: { name: 'Acme', billing_contact_id: CONTACT_ID },
        scopes: [],
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 422,
      context: {
        requestId: REQUEST_ID,
        details: {
          field: 'billing_contact_id',
          reason: 'contact_company_mismatch',
          contact_id: CONTACT_ID,
        },
      },
    });
    expect(prisma.company.create).not.toHaveBeenCalled();
    expect(validator.assertLinkable).not.toHaveBeenCalled();
  });

  it('absent billing_contact_id → created as before', async () => {
    const prisma = mockPrisma();
    const repo = new CompanyRepository(prisma as never);
    await repo.create({
      tenant_id: TENANT_ID,
      entered_by_id: ACTOR_ID,
      input: { name: 'Acme' },
      scopes: [],
      requestId: REQUEST_ID,
    });
    expect(prisma.company.create).toHaveBeenCalledTimes(1);
  });
});

describe('CONTACTS-1 SD-6 — billing_contact_id on import create', () => {
  it('non-null billing_contact_id on an imported company → 422 VALIDATION_ERROR; no write', async () => {
    const prisma = mockPrisma();
    const repo = new CompanyRepository(prisma as never);
    await expect(
      repo.createForImport({
        tenant_id: TENANT_ID,
        entered_by_id: ACTOR_ID,
        import_batch_id: 'batch-1',
        input: { name: 'Acme', billing_contact_id: CONTACT_ID },
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 422,
      context: { details: { field: 'billing_contact_id', reason: 'contact_company_mismatch' } },
    });
    expect(prisma.company.create).not.toHaveBeenCalled();
  });
});

describe('CONTACTS-1 — department list visibility', () => {
  function listPrisma() {
    return { companyDepartment: { findMany: vi.fn().mockResolvedValue([deptRow(VISIBLE)]) } };
  }

  it('invisible company → the invisible-company 404; no read', async () => {
    const prisma = listPrisma();
    const repo = new CompanyDepartmentRepository(prisma as never);
    await expect(
      repo.listForActor({ tenant_id: TENANT_ID, company_id: INVISIBLE, visibility: scoped(), requestId: REQUEST_ID }),
    ).rejects.toMatchObject(INVISIBLE_READ_404);
    expect(prisma.companyDepartment.findMany).not.toHaveBeenCalled();
  });

  it('visible company → its departments; see_all → its departments', async () => {
    const prisma = listPrisma();
    const repo = new CompanyDepartmentRepository(prisma as never);
    const a = await repo.listForActor({ tenant_id: TENANT_ID, company_id: VISIBLE, visibility: scoped(), requestId: REQUEST_ID });
    const b = await repo.listForActor({
      tenant_id: TENANT_ID,
      company_id: INVISIBLE,
      visibility: { ...scoped(), see_all_company: true },
      requestId: REQUEST_ID,
    });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('the controller resolves visibility for GET :company_id/departments', async () => {
    const deptRepo = { listForActor: vi.fn().mockResolvedValue([]) };
    const ctl = new CompanyController({} as never, deptRepo as never);
    const v = scoped();
    const req = { resolveVisibility: vi.fn().mockResolvedValue(v) } as unknown as Request;
    const auth = { sub: ACTOR_ID, tenant_id: TENANT_ID, scopes: ['company:read'] } as unknown as AuthContextType;
    await ctl.listDepartments(auth, VISIBLE, REQUEST_ID, req);
    expect(deptRepo.listForActor).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      company_id: VISIBLE,
      visibility: v,
      requestId: REQUEST_ID,
    });
  });
});
