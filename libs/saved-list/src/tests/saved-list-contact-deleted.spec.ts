import { AramoError } from '@aramo/common';
import { describe, expect, it } from 'vitest';

import { SavedListRepository } from '../lib/saved-list.repository.js';

// CONTACTS-1 SD-6 — adding a contact to a saved list refuses a DELETED contact
// with CONTACT_DELETED (422). The add-time owner check keeps its existing
// semantics for an absent contact (NOT_FOUND 404) and still accepts a live one.
// ContactRepository.findById returns the tombstone (deleted_at set), which is
// what the repository keys on.

const TENANT = '00000000-0000-4000-8000-0000000000a1';
const LIST = '00000000-0000-4000-8000-0000000000f1';
const OWNER = '00000000-0000-4000-8000-0000000000e1';
const LIVE = '00000000-0000-4000-8000-0000000000d1';
const MISSING = '00000000-0000-4000-8000-0000000000d2';
const DELETED = '00000000-0000-4000-8000-0000000000d4';

const CONTACTS = new Map<string, { id: string; deleted_at: string | null }>([
  [LIVE, { id: LIVE, deleted_at: null }],
  [DELETED, { id: DELETED, deleted_at: '2026-11-02T00:00:00.000Z' }],
]);

function build() {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    savedList: {
      findFirst: async () => ({
        id: LIST,
        tenant_id: TENANT,
        site_id: null,
        owner_id: OWNER,
        name: 'Hiring managers',
        item_type: 'contact',
        visibility: 'tenant',
        purpose: null,
        created_at: new Date(0),
        updated_at: new Date(0),
      }),
    },
    savedListEntry: {
      findUnique: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'entry-1', ...args.data, created_at: new Date(0) };
      },
    },
  };
  const contactRepository = {
    findById: async (args: { tenant_id: string; id: string }) => CONTACTS.get(args.id) ?? null,
  };
  const repo = new SavedListRepository(
    prisma as never,
    {} as never,
    {} as never,
    contactRepository as never,
    {} as never,
  );
  return { repo, created };
}

const add = (repo: SavedListRepository, item_id: string) =>
  repo.addEntry({
    tenant_id: TENANT,
    saved_list_id: LIST,
    actor: { actor_id: OWNER, is_admin: false },
    input: { item_type: 'contact', item_id },
    requestId: 'req-sl',
  });

async function errorOf(p: Promise<unknown>): Promise<AramoError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AramoError) return err;
    throw err;
  }
  throw new Error('expected an AramoError');
}

describe('CONTACTS-1 SD-6 — SavedList add refuses a deleted contact', () => {
  it('refuses a deleted contact with CONTACT_DELETED (422) and writes nothing', async () => {
    const { repo, created } = build();
    const err = await errorOf(add(repo, DELETED));
    expect(err.code).toBe('CONTACT_DELETED');
    expect(err.statusCode).toBe(422);
    expect(err.context.details).toEqual({ field: 'item_id', contact_id: DELETED });
    expect(created).toHaveLength(0);
  });

  it('keeps NOT_FOUND (404) for a contact absent from the tenant', async () => {
    const { repo, created } = build();
    const err = await errorOf(add(repo, MISSING));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.statusCode).toBe(404);
    expect(created).toHaveLength(0);
  });

  it('adds a live contact', async () => {
    const { repo, created } = build();
    const view = await add(repo, LIVE);
    expect(view.item_id).toBe(LIVE);
    expect(created).toHaveLength(1);
  });
});
