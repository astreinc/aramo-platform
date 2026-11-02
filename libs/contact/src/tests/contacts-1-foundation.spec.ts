import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request } from 'express';
import type { AuthContextType } from '@aramo/auth';
import type { VisibilityContextShape } from '@aramo/common';
import type { CompanyDepartmentRepository, CompanyRepository } from '@aramo/company';

import { ContactController } from '../lib/contact.controller.js';
import { ContactRepository } from '../lib/contact.repository.js';
import type { ContactAuditSink, ContactOwnerValidator } from '../lib/contact-owner-validator.port.js';
import { CreateContactRequestDto } from '../lib/dto/create-contact-request.dto.js';
import { UpdateContactRequestDto } from '../lib/dto/update-contact-request.dto.js';

// CONTACTS-1 (LOCKED v1.0) — the libs/contact foundation: write-path
// visibility (W-1), soft delete + restore (SD-1..SD-11), the shared link check
// (SD-6), in-tenant reference checks (V-3), the Former / Deleted filters (F-1,
// SD-9), contact_kind (§12) and the validated request classes (V-1/V-2).

const RQ = 'rq-contacts-1';
const TENANT = '01900000-0000-7000-8000-000000000001';
const ACTOR = '01900000-0000-7000-8000-0000000000aa';
const CO_VISIBLE = '01900000-0000-7000-8000-000000000201';
const CO_HIDDEN = '01900000-0000-7000-8000-000000000299';
const CONTACT = '01900000-0000-7000-8000-000000000301';
const OTHER = '01900000-0000-7000-8000-000000000302';
const DEPT = '01900000-0000-7000-8000-000000000401';

function vis(seeAll = false): VisibilityContextShape {
  return {
    tenant_id: TENANT,
    actor_user_id: ACTOR,
    see_all_company: seeAll,
    see_all_requisition: false,
    visible_client_ids: new Set([CO_VISIBLE]),
  } as unknown as VisibilityContextShape;
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONTACT,
    tenant_id: TENANT,
    site_id: null,
    company_id: CO_VISIBLE,
    company_department_id: null,
    first_name: 'Sarah',
    last_name: 'Johnson',
    title: null,
    email1: null,
    email2: null,
    phone_work: null,
    phone_cell: null,
    phone_other: null,
    address: null,
    address2: null,
    city: null,
    state: null,
    zip: null,
    is_hot: false,
    notes: null,
    left_company: false,
    is_primary: true,
    reports_to_id: null,
    owner_id: ACTOR,
    entered_by_id: ACTOR,
    created_at: new Date('2026-11-01T00:00:00Z'),
    updated_at: new Date('2026-11-01T00:00:00Z'),
    relationship_role: null,
    preference: null,
    last_activity_at: null,
    contact_kind: null,
    deleted_at: null,
    deleted_by_id: null,
    ...over,
  };
}

const company = {
  findById: vi.fn().mockResolvedValue({ id: CO_VISIBLE }),
  findNamesByIds: vi.fn().mockResolvedValue(new Map<string, string>()),
  findRelationshipTypesByIds: vi.fn().mockResolvedValue(new Map<string, string[]>()),
} as unknown as CompanyRepository;

function makeRepo(prisma: Record<string, unknown>, opts: {
  departments?: Array<{ id: string }>;
  owner?: ContactOwnerValidator;
  audit?: ContactAuditSink;
} = {}): ContactRepository {
  const departments = {
    list: vi.fn().mockResolvedValue(opts.departments ?? []),
  } as unknown as CompanyDepartmentRepository;
  return new ContactRepository(
    prisma as never,
    company,
    departments,
    opts.owner,
    opts.audit,
  );
}

function prismaWith(contact: Record<string, unknown>): Record<string, unknown> {
  return {
    contact,
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ contact })),
  };
}

describe('W-1 — contact writes resolve visibility', () => {
  it('update on a contact at a company outside the visible set is NOT_FOUND and writes nothing', async () => {
    const contact = {
      findFirst: vi.fn().mockResolvedValue(row({ company_id: CO_HIDDEN })),
      update: vi.fn(),
    };
    const repo = makeRepo(prismaWith(contact));
    await expect(
      repo.update({ tenant_id: TENANT, id: CONTACT, input: { title: 'x' }, requestId: RQ, visibility: vis() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(contact.update).not.toHaveBeenCalled();
  });

  it('update by a see_all actor on the same contact succeeds', async () => {
    const contact = {
      findFirst: vi.fn().mockResolvedValue(row({ company_id: CO_HIDDEN })),
      update: vi.fn().mockResolvedValue(row({ company_id: CO_HIDDEN, title: 'x' })),
    };
    const repo = makeRepo(prismaWith(contact));
    const view = await repo.update({
      tenant_id: TENANT, id: CONTACT, input: { title: 'x' }, requestId: RQ, visibility: vis(true),
    });
    expect(view.title).toBe('x');
  });

  it('update on a soft-deleted contact is NOT_FOUND (SD-7): the lookup filters deleted_at: null', async () => {
    const contact = { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() };
    const repo = makeRepo(prismaWith(contact));
    await expect(
      repo.update({ tenant_id: TENANT, id: CONTACT, input: { title: 'x' }, requestId: RQ, visibility: vis() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(contact.findFirst.mock.calls[0][0].where).toMatchObject({ deleted_at: null });
  });

  it('the controller passes the resolved visibility to update, delete and restore', async () => {
    const repo = {
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
      restore: vi.fn().mockResolvedValue({}),
    };
    const ctl = new ContactController(repo as unknown as ContactRepository);
    const auth = { sub: ACTOR, tenant_id: TENANT, scopes: ['contact:edit', 'contact:delete'] } as unknown as AuthContextType;
    const v = vis();
    const req = { resolveVisibility: vi.fn().mockResolvedValue(v) } as unknown as Request;
    await ctl.update(auth, CONTACT, {} as UpdateContactRequestDto, RQ, req);
    await ctl.delete(auth, CONTACT, RQ, req);
    await ctl.restore(auth, CONTACT, RQ, req);
    expect(repo.update.mock.calls[0][0].visibility).toBe(v);
    expect(repo.delete.mock.calls[0][0]).toMatchObject({ visibility: v, actor_id: ACTOR });
    expect(repo.restore.mock.calls[0][0]).toMatchObject({ visibility: v, actor_id: ACTOR });
  });
});

describe('SD-1/SD-2/SD-11 — soft delete', () => {
  it('marks the row deleted, clears primary, never hard-deletes, and audits', async () => {
    const contact = {
      findFirst: vi.fn().mockResolvedValue(row()),
      update: vi.fn().mockResolvedValue(row()),
      delete: vi.fn(),
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const repo = makeRepo(prismaWith(contact), { audit });
    await repo.delete({ tenant_id: TENANT, id: CONTACT, requestId: RQ, visibility: vis(), actor_id: ACTOR });
    expect(contact.delete).not.toHaveBeenCalled();
    const data = contact.update.mock.calls[0][0].data;
    expect(data.deleted_by_id).toBe(ACTOR);
    expect(data.deleted_at).toBeInstanceOf(Date);
    expect(data.is_primary).toBe(false);
    expect(audit.record).toHaveBeenCalledWith({
      event: 'deleted', tenant_id: TENANT, actor_id: ACTOR, contact_id: CONTACT, company_id: CO_VISIBLE,
    });
  });

  it('delete of an invisible contact is NOT_FOUND and neither writes nor audits', async () => {
    const contact = { findFirst: vi.fn().mockResolvedValue(row({ company_id: CO_HIDDEN })), update: vi.fn() };
    const audit = { record: vi.fn() };
    const repo = makeRepo(prismaWith(contact), { audit });
    await expect(
      repo.delete({ tenant_id: TENANT, id: CONTACT, requestId: RQ, visibility: vis(), actor_id: ACTOR }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(contact.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('import revert (SD-10) soft-deletes the batch with updateMany, never deleteMany', async () => {
    const contact = { updateMany: vi.fn().mockResolvedValue({ count: 3 }), deleteMany: vi.fn() };
    const repo = makeRepo(prismaWith(contact));
    const n = await repo.deleteByImportBatch({ tenant_id: TENANT, import_batch_id: 'b-1' });
    expect(n).toBe(3);
    expect(contact.deleteMany).not.toHaveBeenCalled();
    expect(contact.updateMany.mock.calls[0][0]).toMatchObject({
      where: { tenant_id: TENANT, import_batch_id: 'b-1', deleted_at: null },
      data: { is_primary: false },
    });
  });
});

describe('SD-8 — restore', () => {
  it('clears deleted_at, audits, and does not re-promote primary', async () => {
    const contact = {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(null) // not live
        .mockResolvedValueOnce(row({ deleted_at: new Date(), is_primary: false })) // the deleted row
        .mockResolvedValueOnce(row({ is_primary: false })), // re-read after restore
      update: vi.fn().mockResolvedValue(row()),
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const repo = makeRepo(prismaWith(contact), { audit });
    const view = await repo.restore({ tenant_id: TENANT, id: CONTACT, requestId: RQ, visibility: vis(), actor_id: ACTOR });
    expect(contact.update.mock.calls[0][0].data).toEqual({ deleted_at: null, deleted_by_id: null });
    expect(view.is_primary).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ event: 'restored' }));
  });

  it('restoring a live contact is a no-op that returns the view', async () => {
    const contact = { findFirst: vi.fn().mockResolvedValue(row()), update: vi.fn() };
    const repo = makeRepo(prismaWith(contact));
    const view = await repo.restore({ tenant_id: TENANT, id: CONTACT, requestId: RQ, visibility: vis(), actor_id: ACTOR });
    expect(view.id).toBe(CONTACT);
    expect(contact.update).not.toHaveBeenCalled();
  });
});

describe('SD-6 — assertLinkable', () => {
  const linkable = (found: Record<string, unknown> | null) =>
    makeRepo(prismaWith({ findFirst: vi.fn().mockResolvedValue(found) }));

  it('not in tenant → VALIDATION_ERROR contact_not_found (422)', async () => {
    await expect(
      linkable(null).assertLinkable({ tenant_id: TENANT, id: OTHER, requestId: RQ, field: 'contact_id' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422, context: { details: { reason: 'contact_not_found', field: 'contact_id' } } });
  });

  it('at another company → VALIDATION_ERROR contact_company_mismatch (422)', async () => {
    await expect(
      linkable({ id: OTHER, company_id: CO_HIDDEN, deleted_at: null }).assertLinkable({
        tenant_id: TENANT, id: OTHER, company_id: CO_VISIBLE, requestId: RQ, field: 'contact_id',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'contact_company_mismatch' } } });
  });

  it('soft-deleted → CONTACT_DELETED (422)', async () => {
    await expect(
      linkable({ id: OTHER, company_id: CO_VISIBLE, deleted_at: new Date() }).assertLinkable({
        tenant_id: TENANT, id: OTHER, company_id: CO_VISIBLE, requestId: RQ, field: 'billing_contact_id',
      }),
    ).rejects.toMatchObject({ code: 'CONTACT_DELETED', statusCode: 422, context: { details: { field: 'billing_contact_id', contact_id: OTHER } } });
  });

  it('a live contact at the right company passes', async () => {
    await expect(
      linkable({ id: OTHER, company_id: CO_VISIBLE, deleted_at: null }).assertLinkable({
        tenant_id: TENANT, id: OTHER, company_id: CO_VISIBLE, requestId: RQ, field: 'contact_id',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('V-3 — in-tenant reference checks', () => {
  it('reports_to_id = self is refused', async () => {
    const contact = { findFirst: vi.fn().mockResolvedValue(row()), update: vi.fn() };
    const repo = makeRepo(prismaWith(contact));
    await expect(
      repo.update({ tenant_id: TENANT, id: CONTACT, input: { reports_to_id: CONTACT }, requestId: RQ, visibility: vis() }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'self_reference' } } });
  });

  it('a department of another company is refused', async () => {
    const contact = { findFirst: vi.fn().mockResolvedValue(row()), update: vi.fn() };
    const repo = makeRepo(prismaWith(contact), { departments: [{ id: 'some-other-dept' }] });
    await expect(
      repo.update({ tenant_id: TENANT, id: CONTACT, input: { company_department_id: DEPT }, requestId: RQ, visibility: vis() }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'department_company_mismatch' } } });
  });

  it('a changed owner_id goes through the owner port; an unchanged one does not', async () => {
    const owner = { assertAssignable: vi.fn().mockResolvedValue(undefined) };
    const contact = { findFirst: vi.fn().mockResolvedValue(row()), update: vi.fn().mockResolvedValue(row()) };
    const repo = makeRepo(prismaWith(contact), { owner });
    await repo.update({ tenant_id: TENANT, id: CONTACT, input: { owner_id: ACTOR }, requestId: RQ, visibility: vis() });
    expect(owner.assertAssignable).not.toHaveBeenCalled();
    await repo.update({ tenant_id: TENANT, id: CONTACT, input: { owner_id: OTHER }, requestId: RQ, visibility: vis() });
    expect(owner.assertAssignable).toHaveBeenCalledWith({ tenant_id: TENANT, user_id: OTHER, requestId: RQ, field: 'owner_id' });
  });

  it('contact_kind outside the closed vocabulary is refused; a valid one is written', async () => {
    const contact = { findFirst: vi.fn().mockResolvedValue(row()), update: vi.fn().mockResolvedValue(row({ contact_kind: 'FUNCTIONAL_MAILBOX' })) };
    const repo = makeRepo(prismaWith(contact));
    await expect(
      repo.update({ tenant_id: TENANT, id: CONTACT, input: { contact_kind: 'TEAM' }, requestId: RQ, visibility: vis() }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { field: 'contact_kind' } } });
    const view = await repo.update({
      tenant_id: TENANT, id: CONTACT, input: { contact_kind: 'FUNCTIONAL_MAILBOX' }, requestId: RQ, visibility: vis(),
    });
    expect(contact.update.mock.calls[0][0].data).toEqual({ contact_kind: 'FUNCTIONAL_MAILBOX' });
    expect(view.contact_kind).toBe('FUNCTIONAL_MAILBOX');
  });
});

describe('F-1 / SD-3 / SD-9 / F-4 — directory filters', () => {
  function pagedPrisma() {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    return {
      prisma: { contact: { findMany, count, groupBy: vi.fn().mockResolvedValue([]) } },
      findMany,
      count,
    };
  }

  it('the default page excludes deleted and former rows', async () => {
    const p = pagedPrisma();
    await makeRepo(p.prisma).searchPaged({ tenant_id: TENANT }, vis());
    expect(p.findMany.mock.calls[0][0].where).toMatchObject({ deleted_at: null, left_company: false });
  });

  it('former=true returns ONLY former rows while the facet base stays unfiltered on left_company', async () => {
    const p = pagedPrisma();
    await makeRepo(p.prisma).searchPaged({ tenant_id: TENANT, former: true }, vis());
    expect(p.findMany.mock.calls[0][0].where).toMatchObject({ left_company: true, deleted_at: null });
    const totalWhere = p.count.mock.calls.at(-1)?.[0].where;
    expect(totalWhere).not.toHaveProperty('left_company');
  });

  it('deleted=true returns ONLY deleted rows', async () => {
    const p = pagedPrisma();
    await makeRepo(p.prisma).searchPaged({ tenant_id: TENANT, deleted: true }, vis());
    expect(p.findMany.mock.calls[0][0].where).toMatchObject({ deleted_at: { not: null } });
  });

  it('facets carry the server-side primary count', async () => {
    const p = pagedPrisma();
    p.count.mockResolvedValue(4);
    const page = await makeRepo(p.prisma).searchPaged({ tenant_id: TENANT }, vis());
    expect(page.facets.primary).toBe(4);
  });

  it('?deleted=true without contact:delete is 403', async () => {
    const ctl = new ContactController({ searchPaged: vi.fn() } as unknown as ContactRepository);
    const auth = { sub: ACTOR, tenant_id: TENANT, scopes: ['contact:read'] } as unknown as AuthContextType;
    const req = { resolveVisibility: vi.fn().mockResolvedValue(vis()) } as unknown as Request;
    await expect(
      ctl.list(auth, undefined, undefined, undefined, 'true', undefined, { paged: 'true', deleted: 'true' }, RQ, req),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
  });

  it('GET :id excludes a deleted row unless include_deleted=true (SD-4/SD-5)', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repo = makeRepo({ contact: { findFirst } });
    await repo.findByIdForActor({ tenant_id: TENANT, id: CONTACT, visibility: vis() });
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ deleted_at: null });
    await repo.findByIdForActor({ tenant_id: TENANT, id: CONTACT, visibility: vis(), include_deleted: true });
    expect(findFirst.mock.calls[1][0].where).not.toHaveProperty('deleted_at');
  });
});

describe('H-2 — touchLastActivity only moves forward and skips deleted contacts', () => {
  it('guards on deleted_at null and an older (or null) last_activity_at', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const at = new Date('2026-11-02T10:00:00Z');
    await makeRepo({ contact: { updateMany } }).touchLastActivity({ tenant_id: TENANT, id: CONTACT, at });
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: {
        tenant_id: TENANT,
        id: CONTACT,
        deleted_at: null,
        OR: [{ last_activity_at: null }, { last_activity_at: { lt: at } }],
      },
      data: { last_activity_at: at },
    });
  });
});

describe('V-1/V-2 — validated request classes', () => {
  async function errorsFor(cls: new () => object, body: Record<string, unknown>): Promise<string[]> {
    const errs = await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true });
    return errs.map((e) => e.property);
  }

  it('create refuses a malformed email, a non-UUID company and an unknown field', async () => {
    expect(
      await errorsFor(CreateContactRequestDto, {
        company_id: 'not-a-uuid', first_name: 'A', last_name: 'B', email1: 'nope', surprise: 1,
      }),
    ).toEqual(expect.arrayContaining(['company_id', 'email1', 'surprise']));
  });

  it('create accepts a well-formed body', async () => {
    expect(
      await errorsFor(CreateContactRequestDto, {
        company_id: CO_VISIBLE, first_name: 'Sarah', last_name: 'Johnson', email1: 'sarah@example.com', contact_kind: 'PERSON',
      }),
    ).toEqual([]);
  });

  it('update refuses null on a non-nullable column but allows null to clear a nullable one', async () => {
    expect(await errorsFor(UpdateContactRequestDto, { first_name: null })).toEqual(['first_name']);
    expect(await errorsFor(UpdateContactRequestDto, { title: null, email1: null, contact_kind: null })).toEqual([]);
  });
});
