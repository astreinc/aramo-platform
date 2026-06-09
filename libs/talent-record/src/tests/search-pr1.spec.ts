import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';

import { TalentRecordController } from '../lib/talent-record.controller.js';
import type { TalentRecordRepository } from '../lib/talent-record.repository.js';
import type { TalentLinkService } from '../lib/talent-link.service.js';

// Search PR-1 — talent quick-search proofs (GET /v1/talent-records?q=).
// Lead rulings R1 (REUSE talent:search) / R3 (ILIKE-contains) / R5
// (per-column OR over first_name/last_name). Talent is pool-open — the
// trigram filter ANDs with tenant+site (no visibility resolver).

const REQUEST_ID = 'rq-search-pr1-talent-001';
const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';

function makeAuthContext(scopes: string[]): AuthContextType {
  return {
    sub: ACTOR_ID,
    tenant_id: TENANT_ID,
    scopes,
    consumer_type: 'tenant_user',
    capabilities: ['ats'],
  } as unknown as AuthContextType;
}

function makeController(): {
  ctl: TalentRecordController;
  repo: { list: ReturnType<typeof vi.fn> };
} {
  const repo = { list: vi.fn().mockResolvedValue([]) };
  const ctl = new TalentRecordController(
    repo as unknown as TalentRecordRepository,
    {} as unknown as TalentLinkService,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
  );
  return { ctl, repo };
}

describe('Search PR-1 — talent ?q= scope-gate (controller)', () => {
  it('q present WITHOUT talent:search → 403 INSUFFICIENT_PERMISSIONS', async () => {
    const { ctl } = makeController();
    const auth = makeAuthContext(['talent:read']); // read but NOT search
    await expect(
      ctl.list(auth, undefined, 'jane', REQUEST_ID),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
    });
  });

  it('q present WITHOUT talent:search → error details name the required scope', async () => {
    const { ctl } = makeController();
    const auth = makeAuthContext(['talent:read']);
    try {
      await ctl.list(auth, undefined, 'jane', REQUEST_ID);
      throw new Error('expected throw');
    } catch (e) {
      const err = e as AramoError;
      expect(err.context.details).toMatchObject({
        reason: 'search_scope_missing',
        required_scope: 'talent:search',
      });
    }
  });

  it('q present WITH talent:search → repo.list called with the trimmed term', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:read', 'talent:search']);
    await ctl.list(auth, undefined, '  jane  ', REQUEST_ID);
    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT_ID, q: 'jane' }),
    );
  });

  it('no q → repo.list called with q undefined (backward-compat; no gate)', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:read']); // no search scope needed
    await ctl.list(auth, undefined, undefined, REQUEST_ID);
    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT_ID, q: undefined }),
    );
  });

  it('whitespace-only q → treated as absent (no gate, q undefined)', async () => {
    const { ctl, repo } = makeController();
    const auth = makeAuthContext(['talent:read']);
    await ctl.list(auth, undefined, '   ', REQUEST_ID);
    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ q: undefined }),
    );
  });
});

describe('Search PR-1 — talent ?q= WHERE construction (repo)', () => {
  it('q builds an ILIKE-contains OR over first_name/last_name, ANDed with tenant', async () => {
    // Re-import the concrete repo against a mocked prisma to inspect the WHERE.
    const { TalentRecordRepository: Repo } = await import(
      '../lib/talent-record.repository.js'
    );
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new Repo({ talentRecord: { findMany } } as never);
    await repo.list({ tenant_id: TENANT_ID, q: 'jane' });
    const where = findMany.mock.calls[0][0].where;
    expect(where.tenant_id).toBe(TENANT_ID);
    expect(where.OR).toEqual([
      { first_name: { contains: 'jane', mode: 'insensitive' } },
      { last_name: { contains: 'jane', mode: 'insensitive' } },
    ]);
  });

  it('no q → no OR key (the LIST WHERE is unchanged; backward-compat)', async () => {
    const { TalentRecordRepository: Repo } = await import(
      '../lib/talent-record.repository.js'
    );
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new Repo({ talentRecord: { findMany } } as never);
    await repo.list({ tenant_id: TENANT_ID });
    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
    expect(where.tenant_id).toBe(TENANT_ID);
  });
});
