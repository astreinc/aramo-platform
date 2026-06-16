import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AuthContextType } from '@aramo/auth';
import type { VisibilityContextShape } from '@aramo/common';

import { CompanyController } from '../lib/company.controller.js';
import { CompanyRepository } from '../lib/company.repository.js';

// Phase 2 — server-side faceted page (GET /v1/companies?paged=true). The route +
// gate are unchanged (company:read; ?q= still adds company:search); paged=true
// switches the projection to {items, next_cursor, facets, total}.

const REQUEST_ID = 'rq-company-paged-001';
const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';
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

describe('Phase 2 — company ?paged=true (controller param parsing)', () => {
  it('parses facets/scope into the CompanySearchQuery and returns the page', async () => {
    const page = { items: [], next_cursor: null, facets: {}, total: 0 };
    const repo = { searchPaged: vi.fn().mockResolvedValue(page) };
    const ctl = new CompanyController(repo as unknown as CompanyRepository);
    const auth = makeAuthContext(['company:read']);
    const qp = {
      paged: 'true',
      scope: 'mine',
      status: 'active,prospect',
      client_tier: 'a',
      industry: 'Robotics',
      is_hot: 'true',
      off_limits: 'true',
      quiet: 'true',
      sort: 'name',
      dir: 'asc',
      page_size: '25',
    };
    const res = await ctl.list(
      auth,
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
      owner_id: ACTOR_ID, // scope=mine derives owner server-side (not trusted)
      status: ['active', 'prospect'],
      client_tier: ['a'],
      industry: ['Robotics'],
      is_hot: true,
      off_limits: true,
      quiet: true,
      sort: 'name',
      dir: 'asc',
      page_size: 25,
    });
    expect(visibility.visible_client_ids).toBeDefined();
  });

  it('no paged flag → falls back to the plain list (items shape)', async () => {
    const repo = {
      listForActor: vi.fn().mockResolvedValue([]),
      searchPaged: vi.fn(),
    };
    const ctl = new CompanyController(repo as unknown as CompanyRepository);
    const auth = makeAuthContext(['company:read']);
    const res = await ctl.list(
      auth,
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

describe('Phase 2 — searchPaged WHERE + facet construction (repo)', () => {
  function mockPrisma() {
    const findMany = vi.fn().mockResolvedValue([]);
    const groupBy = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const prisma = { company: { findMany, groupBy, count } };
    return { prisma, findMany, groupBy, count };
  }

  it('item where = base (visibility-AND) + the facet selections; facets over base only', async () => {
    const { prisma, findMany, count } = mockPrisma();
    const repo = new CompanyRepository(prisma as never);
    await repo.searchPaged(
      {
        tenant_id: TENANT_ID,
        owner_id: ACTOR_ID,
        status: ['prospect'],
        is_hot: true,
        quiet: true,
      },
      makeVisibility(),
    );
    const itemWhere = findMany.mock.calls[0][0].where;
    // base predicates
    expect(itemWhere.tenant_id).toBe(TENANT_ID);
    expect(itemWhere.owner_id).toBe(ACTOR_ID);
    expect(itemWhere.id).toEqual({ in: [VISIBLE_A, VISIBLE_B] });
    // selection predicates
    expect(itemWhere.status).toEqual({ in: ['prospect'] });
    expect(itemWhere.is_hot).toBe(true);
    expect(Array.isArray(itemWhere.OR)).toBe(true); // quiet → last_activity OR
    // total count uses the BASE where (no status/is_hot/quiet selection)
    const totalWhere = count.mock.calls.find(
      (c) => c[0].where.status === undefined && c[0].where.is_hot === undefined,
    )?.[0].where;
    expect(totalWhere).toBeDefined();
    expect(totalWhere.id).toEqual({ in: [VISIBLE_A, VISIBLE_B] });
  });

  it('see_all_company → no id-in predicate (tenant-wide)', async () => {
    const { prisma, findMany } = mockPrisma();
    const repo = new CompanyRepository(prisma as never);
    await repo.searchPaged({ tenant_id: TENANT_ID }, makeVisibility(true));
    const itemWhere = findMany.mock.calls[0][0].where;
    expect(itemWhere.id).toBeUndefined();
    expect(itemWhere.tenant_id).toBe(TENANT_ID);
  });

  it('detects next page via take = page_size + 1 and emits a cursor', async () => {
    const { prisma, findMany } = mockPrisma();
    // 3 rows returned for page_size 2 → hasMore, next_cursor from row[1].id
    const d = new Date('2026-06-01T00:00:00Z');
    const baseRow = {
      created_at: d,
      updated_at: d,
      last_activity_at: null,
      next_action_at: null,
      default_contract_markup_pct: null,
      default_perm_fee_pct: null,
    };
    findMany.mockResolvedValueOnce([
      { ...baseRow, id: 'c1' },
      { ...baseRow, id: 'c2' },
      { ...baseRow, id: 'c3' },
    ]);
    const repo = new CompanyRepository(prisma as never);
    const res = await repo.searchPaged(
      { tenant_id: TENANT_ID, page_size: 2 },
      makeVisibility(true),
    );
    expect(findMany.mock.calls[0][0].take).toBe(3);
    expect(res.items.length).toBe(2);
    expect(res.next_cursor).not.toBeNull();
  });
});
