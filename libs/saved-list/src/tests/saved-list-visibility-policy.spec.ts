import { describe, expect, it } from 'vitest';

import {
  mutateDecision,
  readableWhere,
  type VisibilityActor,
} from '../lib/saved-list-visibility-policy.js';

// CRM-1 — SavedList visibility authority (directive §5.2; PO ruling: TENANT
// lists are tenant-wide READ but creator+admin MUTATE). Pure, DB-free proofs of
// the read predicate + mutate decision for every actor×visibility combination.

const OWNER = 'owner-user-1';
const OTHER = 'other-user-2';

const asOwner: VisibilityActor = { actor_id: OWNER, is_admin: false };
const asOther: VisibilityActor = { actor_id: OTHER, is_admin: false };
const asAdmin: VisibilityActor = { actor_id: OTHER, is_admin: true };

describe('readableWhere — READ predicate composed into the Prisma where', () => {
  it('a non-admin actor is constrained to tenant-visible OR own lists', () => {
    expect(readableWhere(asOther)).toEqual({
      OR: [{ visibility: 'tenant' }, { owner_id: OTHER }],
    });
  });

  it('an admin actor gets no visibility constraint (sees all in-tenant)', () => {
    expect(readableWhere(asAdmin)).toEqual({});
  });
});

describe('mutateDecision — creator + admin only (both private and tenant)', () => {
  const privateList = { owner_id: OWNER, visibility: 'private' as const };
  const tenantList = { owner_id: OWNER, visibility: 'tenant' as const };

  it('creator may mutate their own PRIVATE list', () => {
    expect(mutateDecision(privateList, asOwner)).toBe('ok');
  });

  it('creator may mutate their own TENANT list', () => {
    expect(mutateDecision(tenantList, asOwner)).toBe('ok');
  });

  it('admin may mutate any list', () => {
    expect(mutateDecision(privateList, asAdmin)).toBe('ok');
    expect(mutateDecision(tenantList, asAdmin)).toBe('ok');
  });

  it("another actor cannot even SEE someone else's PRIVATE list → not_found (no leak)", () => {
    expect(mutateDecision(privateList, asOther)).toBe('not_found');
  });

  it('another actor may SEE a TENANT list but may NOT mutate it → forbidden', () => {
    expect(mutateDecision(tenantList, asOther)).toBe('forbidden');
  });
});
