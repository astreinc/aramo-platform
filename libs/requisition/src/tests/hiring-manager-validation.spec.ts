import { AramoError, type VisibilityContextShape } from '@aramo/common';
import { describe, expect, it } from 'vitest';

import type { CreateRequisitionRequestDto } from '../lib/dto/create-requisition-request.dto.js';
import type { RequisitionHiringManagerValidator } from '../lib/ports/hiring-manager-validator.port.js';
import { RequisitionRepository } from '../lib/requisition.repository.js';

// CONTACTS-1 HM-1 / HM-2 / SD-6 — the hiring manager (Requisition.contact_id)
// is validated through the REQUISITION_HIRING_MANAGER_VALIDATOR port on create,
// createForImport and update. The fake validator below plays the apps/api
// adapter: it refuses with the same codes ContactRepository.assertLinkable
// raises (not found / company mismatch → VALIDATION_ERROR 422, deleted →
// CONTACT_DELETED 422). The repository must propagate the refusal BEFORE any
// write, skip the check for a null/absent contact_id, and validate an update
// against the requisition's stored (immutable) company.

const TENANT = '00000000-0000-4000-8000-0000000000a1';
const COMPANY = '00000000-0000-4000-8000-0000000000c1';
const OTHER_COMPANY = '00000000-0000-4000-8000-0000000000c2';
const LIVE = '00000000-0000-4000-8000-0000000000d1';
const MISSING = '00000000-0000-4000-8000-0000000000d2';
const ELSEWHERE = '00000000-0000-4000-8000-0000000000d3';
const DELETED = '00000000-0000-4000-8000-0000000000d4';

const SEE_ALL: VisibilityContextShape = {
  tenant_id: TENANT,
  actor_user_id: '00000000-0000-4000-8000-0000000000e1',
  see_all_company: true,
  see_all_requisition: true,
  visible_client_ids: null,
};

// The contact directory the fake validator answers from.
const CONTACTS = new Map<string, { company_id: string; deleted: boolean }>([
  [LIVE, { company_id: COMPANY, deleted: false }],
  [ELSEWHERE, { company_id: OTHER_COMPANY, deleted: false }],
  [DELETED, { company_id: COMPANY, deleted: true }],
]);

type Call = Parameters<RequisitionHiringManagerValidator['assertLinkable']>[0];

function fakeValidator(): RequisitionHiringManagerValidator & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async assertLinkable(args) {
      calls.push(args);
      const row = CONTACTS.get(args.contact_id);
      if (row === undefined) {
        throw new AramoError('VALIDATION_ERROR', 'not found', 422, {
          requestId: args.requestId,
          details: { field: 'contact_id', reason: 'contact_not_found', contact_id: args.contact_id },
        });
      }
      if (row.company_id !== args.company_id) {
        throw new AramoError('VALIDATION_ERROR', 'mismatch', 422, {
          requestId: args.requestId,
          details: { field: 'contact_id', reason: 'contact_company_mismatch', contact_id: args.contact_id },
        });
      }
      if (row.deleted) {
        throw new AramoError('CONTACT_DELETED', 'deleted', 422, {
          requestId: args.requestId,
          details: { field: 'contact_id', contact_id: args.contact_id },
        });
      }
    },
  };
}

// A read-view row projectView() tolerates (see openings-available-write-demote.spec.ts).
const baseRow = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'created_at' || prop === 'updated_at') return new Date(0);
      return null;
    },
  },
);

// Sentinel thrown by the fake Prisma at the first create write — proves the
// validator let the request through to persistence.
class ReachedWrite extends Error {}

function build(validator: RequisitionHiringManagerValidator | undefined) {
  const writes: Array<Record<string, unknown>> = [];
  const prisma = {
    $transaction: async () => {
      throw new ReachedWrite('reached write');
    },
    requisition: {
      findFirst: async () => ({ id: 'req-1', status: 'open', company_id: COMPANY }),
      updateMany: async (args: { data: Record<string, unknown> }) => {
        writes.push(args.data);
        return { count: 1 };
      },
      findFirstOrThrow: async () => baseRow,
    },
  };
  const capacity = {
    projectCapacity: async () => ({
      openings: 0,
      openings_reserved: 0,
      capacity_balance: 0,
      openings_available: 0,
      capacity_status: 'AVAILABLE',
    }),
  };
  const repo = new RequisitionRepository(
    prisma as never,
    {} as never,
    {} as never,
    capacity as never,
    { deriveByRequisitionIds: async () => new Map() } as never,
    validator,
  );
  return { repo, writes };
}

function createInput(contact_id?: string | null): CreateRequisitionRequestDto {
  return {
    title: 'Hiring manager probe',
    company_id: COMPANY,
    ...(contact_id !== undefined ? { contact_id: contact_id as string } : {}),
  } as CreateRequisitionRequestDto;
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

describe('CONTACTS-1 HM-1 — hiring manager validated on create', () => {
  const create = (repo: RequisitionRepository, contact_id?: string | null) =>
    repo.create({
      tenant_id: TENANT,
      entered_by_id: SEE_ALL.actor_user_id,
      input: createInput(contact_id),
      scopes: ['requisition:create'],
      requestId: 'req-hm',
    });

  it('refuses a contact not in the tenant (422 contact_not_found)', async () => {
    const v = fakeValidator();
    const err = await errorOf(create(build(v).repo, MISSING));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.statusCode).toBe(422);
    expect(err.context.details?.['reason']).toBe('contact_not_found');
    expect(v.calls).toEqual([
      { tenant_id: TENANT, contact_id: MISSING, company_id: COMPANY, requestId: 'req-hm' },
    ]);
  });

  it('refuses a contact at another company (422 contact_company_mismatch)', async () => {
    const err = await errorOf(create(build(fakeValidator()).repo, ELSEWHERE));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.context.details?.['reason']).toBe('contact_company_mismatch');
  });

  it('refuses a deleted contact (422 CONTACT_DELETED)', async () => {
    const err = await errorOf(create(build(fakeValidator()).repo, DELETED));
    expect(err.code).toBe('CONTACT_DELETED');
    expect(err.statusCode).toBe(422);
  });

  it('accepts a live same-company contact (reaches the write)', async () => {
    const v = fakeValidator();
    await expect(create(build(v).repo, LIVE)).rejects.toBeInstanceOf(ReachedWrite);
    expect(v.calls).toHaveLength(1);
  });

  it('skips the check for an absent or null contact_id', async () => {
    const v = fakeValidator();
    await expect(create(build(v).repo)).rejects.toBeInstanceOf(ReachedWrite);
    await expect(create(build(v).repo, null)).rejects.toBeInstanceOf(ReachedWrite);
    expect(v.calls).toHaveLength(0);
  });
});

describe('CONTACTS-1 HM-1 — hiring manager validated on createForImport', () => {
  const importOne = (repo: RequisitionRepository, contact_id?: string) =>
    repo.createForImport({
      tenant_id: TENANT,
      entered_by_id: SEE_ALL.actor_user_id,
      import_batch_id: '00000000-0000-4000-8000-0000000000b1',
      input: createInput(contact_id),
      scopes: ['requisition:import:write'],
      requestId: 'req-hm-import',
    });

  it('refuses not found / company mismatch / deleted, accepts live', async () => {
    expect((await errorOf(importOne(build(fakeValidator()).repo, MISSING))).context.details?.['reason']).toBe(
      'contact_not_found',
    );
    expect((await errorOf(importOne(build(fakeValidator()).repo, ELSEWHERE))).context.details?.['reason']).toBe(
      'contact_company_mismatch',
    );
    expect((await errorOf(importOne(build(fakeValidator()).repo, DELETED))).code).toBe('CONTACT_DELETED');
    await expect(importOne(build(fakeValidator()).repo, LIVE)).rejects.toBeInstanceOf(ReachedWrite);
  });

  it('skips the check when the import record carries no contact_id', async () => {
    const v = fakeValidator();
    await expect(importOne(build(v).repo)).rejects.toBeInstanceOf(ReachedWrite);
    expect(v.calls).toHaveLength(0);
  });
});

describe('CONTACTS-1 HM-1 / HM-2 — hiring manager validated on update', () => {
  const update = (repo: RequisitionRepository, contact_id: string | null | undefined) =>
    repo.update({
      tenant_id: TENANT,
      id: 'req-1',
      input: contact_id === undefined ? { title: 'Renamed' } : { contact_id },
      scopes: ['requisition:edit'],
      actor_id: SEE_ALL.actor_user_id,
      visibility: SEE_ALL,
      requestId: 'req-hm-update',
    });

  it('refuses not found / company mismatch / deleted without writing', async () => {
    for (const [id, expected] of [
      [MISSING, 'contact_not_found'],
      [ELSEWHERE, 'contact_company_mismatch'],
    ] as const) {
      const { repo, writes } = build(fakeValidator());
      const err = await errorOf(update(repo, id));
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.context.details?.['reason']).toBe(expected);
      expect(writes).toHaveLength(0);
    }
    const { repo, writes } = build(fakeValidator());
    expect((await errorOf(update(repo, DELETED))).code).toBe('CONTACT_DELETED');
    expect(writes).toHaveLength(0);
  });

  it('validates against the requisition stored company and writes a live contact', async () => {
    const v = fakeValidator();
    const { repo, writes } = build(v);
    await update(repo, LIVE);
    expect(v.calls).toEqual([
      { tenant_id: TENANT, contact_id: LIVE, company_id: COMPANY, requestId: 'req-hm-update' },
    ]);
    expect(writes[0]?.['contact_id']).toBe(LIVE);
  });

  it('allows clearing (null) and leaves an untouched hiring manager unchecked', async () => {
    const v = fakeValidator();
    const cleared = build(v);
    await update(cleared.repo, null);
    expect(cleared.writes[0]?.['contact_id']).toBeNull();
    const untouched = build(v);
    await update(untouched.repo, undefined);
    expect(Object.keys(untouched.writes[0] ?? {})).not.toContain('contact_id');
    expect(v.calls).toHaveLength(0);
  });

  it('skips the check when the port is unbound (direct-construction specs only)', async () => {
    const { repo, writes } = build(undefined);
    await update(repo, DELETED);
    expect(writes[0]?.['contact_id']).toBe(DELETED);
  });
});
