import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import {
  CompanyBillingContactAdapter,
  ContactOwnerAdapter,
  RequisitionHiringManagerAdapter,
  TaskContactOwnerAdapter,
} from '../contact-links/contact-link-validators.adapter.js';

// CONTACTS-1 (SD-6 / HM-1 / V-3) — the composition-root contact-link adapters.
// Each one forwards to ContactRepository.assertLinkable with its own field
// name (and the company constraint where the link has one), so the refusal the
// caller sees names the field it sent. The contact owner adapter refuses a user
// that is not an active member of the tenant. The fake ContactRepository below
// plays assertLinkable's contract: not in tenant / other company →
// VALIDATION_ERROR 422, deleted → CONTACT_DELETED 422.

const TENANT = 't-1';
const COMPANY = 'co-1';
const LIVE = 'ct-live';
const ELSEWHERE = 'ct-elsewhere';
const DELETED = 'ct-deleted';
const MISSING = 'ct-missing';

const DIRECTORY = new Map<string, { company_id: string; deleted: boolean }>([
  [LIVE, { company_id: COMPANY, deleted: false }],
  [ELSEWHERE, { company_id: 'co-2', deleted: false }],
  [DELETED, { company_id: COMPANY, deleted: true }],
]);

type LinkArgs = {
  tenant_id: string;
  id: string;
  company_id?: string;
  requestId: string;
  field: string;
};

function fakeContacts() {
  return {
    assertLinkable: vi.fn(async (args: LinkArgs) => {
      const row = DIRECTORY.get(args.id);
      if (row === undefined) {
        throw new AramoError('VALIDATION_ERROR', 'not found', 422, {
          requestId: args.requestId,
          details: { field: args.field, reason: 'contact_not_found', contact_id: args.id },
        });
      }
      if (args.company_id !== undefined && row.company_id !== args.company_id) {
        throw new AramoError('VALIDATION_ERROR', 'mismatch', 422, {
          requestId: args.requestId,
          details: { field: args.field, reason: 'contact_company_mismatch', contact_id: args.id },
        });
      }
      if (row.deleted) {
        throw new AramoError('CONTACT_DELETED', 'deleted', 422, {
          requestId: args.requestId,
          details: { field: args.field, contact_id: args.id },
        });
      }
    }),
  };
}

async function errorOf(p: Promise<unknown>): Promise<AramoError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AramoError) return err;
    throw err;
  }
  throw new Error('expected an AramoError');
}

describe('RequisitionHiringManagerAdapter (HM-1)', () => {
  const run = (contacts: ReturnType<typeof fakeContacts>, contact_id: string) =>
    new RequisitionHiringManagerAdapter(contacts as never).assertLinkable({
      tenant_id: TENANT,
      contact_id,
      company_id: COMPANY,
      requestId: 'r',
    });

  it('ok — forwards with field contact_id and the requisition company', async () => {
    const contacts = fakeContacts();
    await expect(run(contacts, LIVE)).resolves.toBeUndefined();
    expect(contacts.assertLinkable).toHaveBeenCalledWith({
      tenant_id: TENANT,
      id: LIVE,
      company_id: COMPANY,
      requestId: 'r',
      field: 'contact_id',
    });
  });

  it('refuses not found / company mismatch / deleted', async () => {
    const contacts = fakeContacts();
    expect((await errorOf(run(contacts, MISSING))).context.details?.['reason']).toBe('contact_not_found');
    expect((await errorOf(run(contacts, ELSEWHERE))).context.details?.['reason']).toBe(
      'contact_company_mismatch',
    );
    const deleted = await errorOf(run(contacts, DELETED));
    expect(deleted.code).toBe('CONTACT_DELETED');
    expect(deleted.context.details?.['field']).toBe('contact_id');
  });
});

describe('CompanyBillingContactAdapter (SD-6)', () => {
  const build = (contacts: ReturnType<typeof fakeContacts>) => {
    const moduleRef = { get: vi.fn(() => contacts) };
    return { adapter: new CompanyBillingContactAdapter(moduleRef as never), moduleRef };
  };
  const run = (adapter: CompanyBillingContactAdapter, contact_id: string) =>
    adapter.assertLinkable({ tenant_id: TENANT, contact_id, company_id: COMPANY, requestId: 'r' });

  it('ok — resolves ContactRepository lazily once and forwards with field billing_contact_id', async () => {
    const contacts = fakeContacts();
    const { adapter, moduleRef } = build(contacts);
    await run(adapter, LIVE);
    await run(adapter, LIVE);
    expect(moduleRef.get).toHaveBeenCalledTimes(1);
    expect(contacts.assertLinkable).toHaveBeenCalledWith({
      tenant_id: TENANT,
      id: LIVE,
      company_id: COMPANY,
      requestId: 'r',
      field: 'billing_contact_id',
    });
  });

  it('refuses not found / company mismatch / deleted', async () => {
    const { adapter } = build(fakeContacts());
    expect((await errorOf(run(adapter, MISSING))).context.details?.['reason']).toBe('contact_not_found');
    expect((await errorOf(run(adapter, ELSEWHERE))).context.details?.['reason']).toBe(
      'contact_company_mismatch',
    );
    const deleted = await errorOf(run(adapter, DELETED));
    expect(deleted.code).toBe('CONTACT_DELETED');
    expect(deleted.context.details?.['field']).toBe('billing_contact_id');
  });
});

describe('TaskContactOwnerAdapter (SD-6)', () => {
  const run = (contacts: ReturnType<typeof fakeContacts>, contact_id: string) =>
    new TaskContactOwnerAdapter(contacts as never).assertLinkable({
      tenant_id: TENANT,
      contact_id,
      requestId: 'r',
    });

  it('ok — forwards with field owner_id and NO company constraint', async () => {
    const contacts = fakeContacts();
    await expect(run(contacts, ELSEWHERE)).resolves.toBeUndefined();
    expect(contacts.assertLinkable).toHaveBeenCalledWith({
      tenant_id: TENANT,
      id: ELSEWHERE,
      requestId: 'r',
      field: 'owner_id',
    });
  });

  it('refuses not found / deleted', async () => {
    const contacts = fakeContacts();
    expect((await errorOf(run(contacts, MISSING))).code).toBe('VALIDATION_ERROR');
    const deleted = await errorOf(run(contacts, DELETED));
    expect(deleted.code).toBe('CONTACT_DELETED');
    expect(deleted.statusCode).toBe(422);
  });
});

describe('ContactOwnerAdapter (V-3 owner_id)', () => {
  const identity = (activeIds: readonly string[]) => ({
    listAssignableTenantUsers: vi.fn(async () =>
      activeIds.map((id) => ({ user_id: id, display_name: null })),
    ),
  });
  const run = (ids: readonly string[], user_id: string) => {
    const id = identity(ids);
    return {
      p: new ContactOwnerAdapter(id as never).assertAssignable({
        tenant_id: TENANT,
        user_id,
        requestId: 'r',
        field: 'owner_id',
      }),
      id,
    };
  };

  it('ok — an active tenant member', async () => {
    const { p, id } = run(['u-1', 'u-2'], 'u-2');
    await expect(p).resolves.toBeUndefined();
    expect(id.listAssignableTenantUsers).toHaveBeenCalledWith(TENANT);
  });

  it('refuses a user outside the active roster (inactive or cross-tenant) — 422 owner_not_assignable', async () => {
    const err = await errorOf(run(['u-1'], 'u-foreign').p);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.statusCode).toBe(422);
    expect(err.context.details).toEqual({
      field: 'owner_id',
      reason: 'owner_not_assignable',
      user_id: 'u-foreign',
    });
  });
});
