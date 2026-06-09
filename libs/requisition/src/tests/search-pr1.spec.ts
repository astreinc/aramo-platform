import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AuthContextType } from '@aramo/auth';
import type { VisibilityContextShape } from '@aramo/common';

import { RequisitionController } from '../lib/requisition.controller.js';
import type { RequisitionRepository } from '../lib/requisition.repository.js';

// Search PR-1 — requisition quick-search proofs (GET /v1/requisitions?q=).
// Lead rulings R2 (requisition:search to requisition:read holders + finance)
// / R3 (ILIKE-contains over `title`). The single-column `title` filter ANDs
// (sibling) with the A3-OR-D4b visibility OR — proving no collision with the
// visibility OR and no-widen.

const REQUEST_ID = 'rq-search-pr1-req-001';
const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';
const VISIBLE_CO = '01900000-0000-7000-8000-000000000201';

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
    visible_client_ids: new Set([VISIBLE_CO]),
  };
}

function makeReq(): Request {
  return {
    resolveVisibility: vi.fn().mockResolvedValue(makeVisibility()),
  } as unknown as Request;
}

function makeController(): {
  ctl: RequisitionController;
  repo: { listForActor: ReturnType<typeof vi.fn> };
} {
  const repo = { listForActor: vi.fn().mockResolvedValue([]) };
  // The controller also takes the assignment repository (write paths); only
  // the requisition repo is exercised by list().
  const ctl = new RequisitionController(
    repo as unknown as RequisitionRepository,
    {} as never,
  );
  return { ctl, repo };
}

describe('Search PR-1 — requisition ?q= scope-gate (controller)', () => {
  it('q present WITHOUT requisition:search → 403 INSUFFICIENT_PERMISSIONS', async () => {
    const { ctl } = makeController();
    const auth = makeAuthContext(['requisition:read']);
    await expect(
      ctl.list(auth, undefined, undefined, 'engineer', REQUEST_ID, makeReq()),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
  });

  it('q present WITH requisition:search → repo called with the trimmed term', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['requisition:read', 'requisition:search']);
    await ctl.list(auth, undefined, undefined, ' engineer ', REQUEST_ID, makeReq());
    expect(repo.listForActor).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT_ID, q: 'engineer' }),
    );
  });

  it('no q → repo called with q undefined (backward-compat; no gate)', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['requisition:read']);
    await ctl.list(auth, undefined, undefined, undefined, REQUEST_ID, makeReq());
    expect(repo.listForActor).toHaveBeenCalledWith(
      expect.objectContaining({ q: undefined }),
    );
  });
});

describe('Search PR-1 — requisition ?q= WHERE construction (repo) — visibility-AND', () => {
  it('q sets a single-column title filter that does NOT collide with the visibility OR', async () => {
    const { RequisitionRepository: Repo } = await import('../lib/requisition.repository.js');
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new Repo({ requisition: { findMany } } as never);
    await repo.listForActor({
      tenant_id: TENANT_ID,
      visibility: makeVisibility(),
      q: 'engineer',
    });
    const where = findMany.mock.calls[0][0].where;
    // The trigram match — a single `title` key (NOT an OR).
    expect(where.title).toEqual({ contains: 'engineer', mode: 'insensitive' });
    // ...ANDed WITH the A3-OR-D4b visibility OR (still present → no-widen,
    // and the q did NOT overwrite the visibility OR key).
    expect(where.OR).toEqual([
      { company_id: { in: [VISIBLE_CO] } },
      { assignments: { some: { user_id: ACTOR_ID } } },
    ]);
    expect(where.tenant_id).toBe(TENANT_ID);
  });

  it('no q → title filter absent; the visibility OR is unchanged', async () => {
    const { RequisitionRepository: Repo } = await import('../lib/requisition.repository.js');
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new Repo({ requisition: { findMany } } as never);
    await repo.listForActor({ tenant_id: TENANT_ID, visibility: makeVisibility() });
    const where = findMany.mock.calls[0][0].where;
    expect(where.title).toBeUndefined();
    expect(where.OR).toBeDefined();
  });
});
