import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AuthContextType } from '@aramo/auth';
import type { VisibilityContextShape } from '@aramo/common';
import type { CompanyRepository } from '@aramo/company';

import { ContactController } from '../lib/contact.controller.js';
import { ContactRepository } from '../lib/contact.repository.js';

// Contact-spec amendment v1.0 — server-side faceted page (GET /v1/contacts?
// paged=true). The route + gate are unchanged (contact:read; ?q= still adds
// contact:search); paged=true switches the projection to {items, next_cursor,
// facets, total}. The "My contacts" scope is a SERVER-ENFORCED owner_id
// predicate (NOT a client filter) — the corrected pattern.

const REQUEST_ID = 'rq-contact-paged-001';
const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';
const OTHER_OWNER = '01900000-0000-7000-8000-0000000000bb';
const VISIBLE_A = '01900000-0000-7000-8000-000000000201';
const VISIBLE_B = '01900000-0000-7000-8000-000000000202';

function makeAuthContext(scopes: string[]): AuthContextType {
  return {
    sub: ACTOR_ID,
    tenant_id: TENANT_ID,
    scopes,
    consumer_type: 'tenant_user',
    capabilities: ['ats'],
  } as unknown as AuthContextType;
}

function makeVisibility(seeAll = false): VisibilityContextShape {
  return {
    tenant_id: TENANT_ID,
    actor_user_id: ACTOR_ID,
    see_all_company: seeAll,
    see_all_requisition: false,
    visible_client_ids: new Set([VISIBLE_A, VISIBLE_B]),
  } as unknown as VisibilityContextShape;
}

function makeReq(seeAll = false): Request {
  return {
    resolveVisibility: vi.fn().mockResolvedValue(makeVisibility(seeAll)),
  } as unknown as Request;
}

const noCompanyNames = {
  findNamesByIds: vi.fn().mockResolvedValue(new Map<string, string>()),
} as unknown as CompanyRepository;

describe('Contact ?paged=true (controller param parsing)', () => {
  it('parses facets/scope into the ContactSearchQuery and returns the page', async () => {
    const page = { items: [], next_cursor: null, facets: {}, total: 0 };
    const repo = { searchPaged: vi.fn().mockResolvedValue(page) };
    const ctl = new ContactController(repo as unknown as ContactRepository);
    const auth = makeAuthContext(['contact:read']);
    const qp = {
      paged: 'true',
      scope: 'mine',
      relationship_role: 'decision_maker,champion',
      preference: 'contactable',
      company_id: VISIBLE_A,
      is_hot: 'true',
      quiet: 'true',
      former: 'true',
      cold_callable: 'true',
      sort: 'last_activity',
      dir: 'asc',
      page_size: '25',
    };
    const res = await ctl.list(
      auth,
      undefined,
      undefined,
      undefined,
      'true',
      'mine',
      qp,
      REQUEST_ID,
      makeReq(),
    );
    expect(res).toBe(page);
    expect(repo.searchPaged).toHaveBeenCalledTimes(1);
    const [query, visibility] = repo.searchPaged.mock.calls[0];
    expect(query).toMatchObject({
      tenant_id: TENANT_ID,
      owner_id: ACTOR_ID, // scope=mine derives owner SERVER-side (not trusted)
      relationship_role: ['decision_maker', 'champion'],
      preference: ['contactable'],
      company_id: [VISIBLE_A],
      is_hot: true,
      quiet: true,
      former: true,
      cold_callable: true,
      sort: 'last_activity',
      dir: 'asc',
      page_size: 25,
    });
    expect(visibility.visible_client_ids).toBeDefined();
  });

  it('CORRECTED-PATTERN: a client-supplied owner_id is IGNORED — owner is only ever the JWT sub', async () => {
    const repo = { searchPaged: vi.fn().mockResolvedValue({ items: [] }) };
    const ctl = new ContactController(repo as unknown as ContactRepository);
    const auth = makeAuthContext(['contact:read']);
    // Malicious client tries to scope to ANOTHER owner via a raw query param.
    const qp = { paged: 'true', scope: 'mine', owner_id: OTHER_OWNER };
    await ctl.list(
      auth,
      undefined,
      undefined,
      undefined,
      'true',
      'mine',
      qp,
      REQUEST_ID,
      makeReq(),
    );
    const [query] = repo.searchPaged.mock.calls[0];
    expect(query.owner_id).toBe(ACTOR_ID); // never OTHER_OWNER
  });

  it('no paged flag → falls back to the plain list (items shape)', async () => {
    const repo = {
      listForActor: vi.fn().mockResolvedValue([]),
      searchPaged: vi.fn(),
    };
    const ctl = new ContactController(repo as unknown as ContactRepository);
    const auth = makeAuthContext(['contact:read']);
    const res = await ctl.list(
      auth,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      REQUEST_ID,
      makeReq(),
    );
    expect(res).toEqual({ items: [] });
    expect(repo.searchPaged).not.toHaveBeenCalled();
  });
});

describe('Contact searchPaged WHERE + facet construction (repo)', () => {
  function mockPrisma() {
    const findMany = vi.fn().mockResolvedValue([]);
    const groupBy = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const prisma = { contact: { findMany, groupBy, count } };
    return { prisma, findMany, groupBy, count };
  }

  it('VISIBILITY ENFORCEMENT: under My scope the query is owner-AND-visibility constrained server-side', async () => {
    const { prisma, findMany, count } = mockPrisma();
    const repo = new ContactRepository(prisma as never, noCompanyNames);
    await repo.searchPaged(
      { tenant_id: TENANT_ID, owner_id: ACTOR_ID },
      makeVisibility(),
    );
    const itemWhere = findMany.mock.calls[0][0].where;
    // The actor's OWN contacts only — owner_id is a hard predicate.
    expect(itemWhere.owner_id).toBe(ACTOR_ID);
    // AND the D4b company-axis visibility predicate.
    expect(itemWhere.company_id).toEqual({ in: [VISIBLE_A, VISIBLE_B] });
    expect(itemWhere.tenant_id).toBe(TENANT_ID);
    // former (left_company) rows excluded by default.
    expect(itemWhere.left_company).toBe(false);
    // The base count (total) carries the SAME owner + visibility constraint —
    // so "of M" can never include another owner's contacts. (The facet counts
    // add is_hot/OR/left_company overrides; the base/total has none.)
    const totalWhere = count.mock.calls.find(
      (c) =>
        c[0].where.is_hot === undefined &&
        c[0].where.OR === undefined &&
        c[0].where.left_company === false,
    )?.[0].where;
    expect(totalWhere).toBeDefined();
    expect(totalWhere.owner_id).toBe(ACTOR_ID);
    expect(totalWhere.company_id).toEqual({ in: [VISIBLE_A, VISIBLE_B] });
  });

  it('item where = base (visibility-AND) + the facet selections; facets over base only', async () => {
    const { prisma, findMany, count } = mockPrisma();
    const repo = new ContactRepository(prisma as never, noCompanyNames);
    await repo.searchPaged(
      {
        tenant_id: TENANT_ID,
        relationship_role: ['decision_maker'],
        is_hot: true,
        quiet: true,
      },
      makeVisibility(),
    );
    const itemWhere = findMany.mock.calls[0][0].where;
    expect(itemWhere.company_id).toEqual({ in: [VISIBLE_A, VISIBLE_B] });
    expect(itemWhere.relationship_role).toEqual({ in: ['decision_maker'] });
    expect(itemWhere.is_hot).toBe(true);
    // quiet → last_activity OR pushed into the AND accumulator (composes, not clobbers).
    expect(Array.isArray(itemWhere.AND)).toBe(true);
    // total count uses the BASE where (no relationship_role/is_hot selection).
    const totalWhere = count.mock.calls.find(
      (c) =>
        c[0].where.is_hot === undefined &&
        c[0].where.OR === undefined &&
        c[0].where.left_company === false,
    )?.[0].where;
    expect(totalWhere).toBeDefined();
    expect(totalWhere.relationship_role).toBeUndefined();
    expect(totalWhere.is_hot).toBeUndefined();
    expect(totalWhere.company_id).toEqual({ in: [VISIBLE_A, VISIBLE_B] });
  });

  it('cold_callable → contactable-or-null AND non-empty work phone, composed in AND', async () => {
    const { prisma, findMany } = mockPrisma();
    const repo = new ContactRepository(prisma as never, noCompanyNames);
    await repo.searchPaged(
      { tenant_id: TENANT_ID, cold_callable: true, sort: 'last_activity', dir: 'asc' },
      makeVisibility(true),
    );
    const itemWhere = findMany.mock.calls[0][0].where;
    const and = itemWhere.AND as Array<Record<string, unknown>>;
    expect(Array.isArray(and)).toBe(true);
    const cold = and.find((c) => Array.isArray(c['AND']));
    expect(cold).toBeDefined();
    // cold-call sort = last_activity asc with nulls FIRST (most overdue leads).
    const orderBy = findMany.mock.calls[0][0].orderBy;
    expect(orderBy[0]).toEqual({ last_activity_at: { sort: 'asc', nulls: 'first' } });
  });

  it('see_all_company → no company_id-in predicate (tenant-wide)', async () => {
    const { prisma, findMany } = mockPrisma();
    const repo = new ContactRepository(prisma as never, noCompanyNames);
    await repo.searchPaged({ tenant_id: TENANT_ID }, makeVisibility(true));
    const itemWhere = findMany.mock.calls[0][0].where;
    expect(itemWhere.company_id).toBeUndefined();
    expect(itemWhere.tenant_id).toBe(TENANT_ID);
  });

  it('detects next page via take = page_size + 1 and emits a cursor', async () => {
    const { prisma, findMany } = mockPrisma();
    const d = new Date('2026-06-01T00:00:00Z');
    const baseRow = {
      created_at: d,
      updated_at: d,
      last_activity_at: null,
      relationship_role: null,
      preference: null,
      company_id: VISIBLE_A,
    };
    findMany.mockResolvedValueOnce([
      { ...baseRow, id: 'c1' },
      { ...baseRow, id: 'c2' },
      { ...baseRow, id: 'c3' },
    ]);
    const repo = new ContactRepository(prisma as never, noCompanyNames);
    const res = await repo.searchPaged(
      { tenant_id: TENANT_ID, page_size: 2 },
      makeVisibility(true),
    );
    expect(findMany.mock.calls[0][0].take).toBe(3);
    expect(res.items.length).toBe(2);
    expect(res.next_cursor).not.toBeNull();
  });
});
