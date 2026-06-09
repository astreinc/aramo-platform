import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AuthContextType } from '@aramo/auth';
import type { VisibilityContextShape } from '@aramo/common';

import { CompanyController } from '../lib/company.controller.js';
import type { CompanyRepository } from '../lib/company.repository.js';

// Search PR-1 — company quick-search proofs (GET /v1/companies?q=). Lead
// rulings R2 (company:search granted to company:read holders) / R3
// (ILIKE-contains over `name`). The trigram filter ANDs with the D4b
// visibility predicate — NARROWS within the visible set, never widens.

const REQUEST_ID = 'rq-search-pr1-company-001';
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

function makeVisibility(): VisibilityContextShape {
  return {
    tenant_id: TENANT_ID,
    actor_user_id: ACTOR_ID,
    see_all_company: false,
    see_all_requisition: false,
    visible_client_ids: new Set([VISIBLE_A, VISIBLE_B]),
  };
}

function makeReq(): Request {
  return {
    resolveVisibility: vi.fn().mockResolvedValue(makeVisibility()),
  } as unknown as Request;
}

function makeController(): {
  ctl: CompanyController;
  repo: { listForActor: ReturnType<typeof vi.fn> };
} {
  const repo = { listForActor: vi.fn().mockResolvedValue([]) };
  const ctl = new CompanyController(repo as unknown as CompanyRepository);
  return { ctl, repo };
}

describe('Search PR-1 — company ?q= scope-gate (controller)', () => {
  it('q present WITHOUT company:search → 403 INSUFFICIENT_PERMISSIONS', async () => {
    const { ctl } = makeController();
    const auth = makeAuthContext(['company:read']);
    await expect(
      ctl.list(auth, undefined, 'acme', REQUEST_ID, makeReq()),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
  });

  it('q present WITH company:search → repo called with the trimmed term', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['company:read', 'company:search']);
    await ctl.list(auth, undefined, '  acme ', REQUEST_ID, makeReq());
    expect(repo.listForActor).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT_ID, q: 'acme' }),
    );
  });

  it('no q → repo called with q undefined (backward-compat; no gate)', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['company:read']);
    await ctl.list(auth, undefined, undefined, REQUEST_ID, makeReq());
    expect(repo.listForActor).toHaveBeenCalledWith(
      expect.objectContaining({ q: undefined }),
    );
  });
});

describe('Search PR-1 — company ?q= WHERE construction (repo) — visibility-AND', () => {
  it('q ANDs the name contains filter WITH the D4b id-in visibility (no-widen)', async () => {
    const { CompanyRepository: Repo } = await import('../lib/company.repository.js');
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new Repo({ company: { findMany } } as never);
    await repo.listForActor({
      tenant_id: TENANT_ID,
      visibility: makeVisibility(),
      q: 'acme',
    });
    const where = findMany.mock.calls[0][0].where;
    // The trigram match...
    expect(where.name).toEqual({ contains: 'acme', mode: 'insensitive' });
    // ...ANDed WITH the D4b visibility predicate (still present → no-widen).
    expect(where.id).toEqual({ in: [VISIBLE_A, VISIBLE_B] });
    expect(where.tenant_id).toBe(TENANT_ID);
  });

  it('no q → name filter absent; the visibility predicate is unchanged', async () => {
    const { CompanyRepository: Repo } = await import('../lib/company.repository.js');
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new Repo({ company: { findMany } } as never);
    await repo.listForActor({ tenant_id: TENANT_ID, visibility: makeVisibility() });
    const where = findMany.mock.calls[0][0].where;
    expect(where.name).toBeUndefined();
    expect(where.id).toEqual({ in: [VISIBLE_A, VISIBLE_B] });
  });
});
