import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AuthContextType } from '@aramo/auth';
import type { VisibilityContextShape } from '@aramo/common';

import { ContactController } from '../lib/contact.controller.js';
import type { ContactRepository } from '../lib/contact.repository.js';

// Search PR-1 — contact quick-search proofs (GET /v1/contacts?q=). Lead
// rulings R2 (contact:search to contact:read holders) / R3 (ILIKE-contains)
// / R5 (per-column OR over first_name/last_name). The OR ANDs with the D4b
// company-axis visibility (which keys on company_id, not OR — no collision).

const REQUEST_ID = 'rq-search-pr1-contact-001';
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
  ctl: ContactController;
  repo: { listForActor: ReturnType<typeof vi.fn> };
} {
  const repo = { listForActor: vi.fn().mockResolvedValue([]) };
  const ctl = new ContactController(repo as unknown as ContactRepository);
  return { ctl, repo };
}

describe('Search PR-1 — contact ?q= scope-gate (controller)', () => {
  it('q present WITHOUT contact:search → 403 INSUFFICIENT_PERMISSIONS', async () => {
    const { ctl } = makeController();
    const auth = makeAuthContext(['contact:read']);
    await expect(
      ctl.list(auth, undefined, undefined, 'smith', REQUEST_ID, makeReq()),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
  });

  it('q present WITH contact:search → repo called with the trimmed term', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['contact:read', 'contact:search']);
    await ctl.list(auth, undefined, undefined, ' smith ', REQUEST_ID, makeReq());
    expect(repo.listForActor).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT_ID, q: 'smith' }),
    );
  });

  it('no q → repo called with q undefined (backward-compat; no gate)', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['contact:read']);
    await ctl.list(auth, undefined, undefined, undefined, REQUEST_ID, makeReq());
    expect(repo.listForActor).toHaveBeenCalledWith(
      expect.objectContaining({ q: undefined }),
    );
  });
});

describe('Search PR-1 — contact ?q= WHERE construction (repo) — visibility-AND', () => {
  it('q builds an OR over first_name/last_name, ANDed with the D4b company-axis filter', async () => {
    const { ContactRepository: Repo } = await import('../lib/contact.repository.js');
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new Repo({ contact: { findMany } } as never, {} as never);
    await repo.listForActor({
      tenant_id: TENANT_ID,
      visibility: makeVisibility(),
      q: 'smith',
    });
    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { first_name: { contains: 'smith', mode: 'insensitive' } },
      { last_name: { contains: 'smith', mode: 'insensitive' } },
    ]);
    // The D4b visibility predicate (company_id in visible) is still present.
    expect(where.company_id).toEqual({ in: [VISIBLE_CO] });
    expect(where.tenant_id).toBe(TENANT_ID);
  });

  it('no q → no OR key; the visibility predicate is unchanged', async () => {
    const { ContactRepository: Repo } = await import('../lib/contact.repository.js');
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new Repo({ contact: { findMany } } as never, {} as never);
    await repo.listForActor({ tenant_id: TENANT_ID, visibility: makeVisibility() });
    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
    expect(where.company_id).toEqual({ in: [VISIBLE_CO] });
  });
});
