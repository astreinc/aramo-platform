import { describe, expect, it, vi } from 'vitest';

import { TalentRecordRepository } from '../lib/talent-record.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: 't',
    site_id: null,
    first_name: 'A',
    last_name: 'B',
    email1: null,
    email2: null,
    phone_home: null,
    phone_cell: null,
    phone_work: null,
    address: null,
    address2: null,
    city: null,
    state: null,
    zip: null,
    source: null,
    key_skills: null,
    current_employer: null,
    current_pay: null,
    desired_pay: null,
    date_available: null,
    can_relocate: false,
    is_hot: false,
    notes: null,
    web_site: null,
    best_time_to_call: null,
    availability_status: null,
    engagement_type: null,
    work_authorization: null,
    owner_id: null,
    entered_by_id: null,
    created_at: new Date('2026-06-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    ...over,
  };
}

function repoWith(over: Record<string, unknown> = {}) {
  const talentRecord = {
    findMany: vi.fn().mockResolvedValue([]),
    groupBy: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    ...over,
  };
  const prisma = { talentRecord } as unknown as PrismaService;
  return { repo: new TalentRecordRepository(prisma), findMany: talentRecord.findMany, groupBy: talentRecord.groupBy, count: talentRecord.count };
}

describe('TalentRecordRepository.searchPaged — keyset + facets', () => {
  it('returns a next_cursor (encoded last id) when a full page+1 is fetched; null otherwise', async () => {
    const { repo, findMany } = repoWith({
      findMany: vi.fn().mockResolvedValue([row('a'), row('b'), row('c')]), // page_size 2 → 3 fetched
    });
    const page = await repo.searchPaged({ tenant_id: 't', page_size: 2 });
    expect(page.items.map((i) => i.id)).toEqual(['a', 'b']); // sliced to page_size
    expect(page.next_cursor).toBe(Buffer.from('b', 'utf8').toString('base64url'));
    expect(findMany.mock.calls[0]![0].take).toBe(3); // page_size + 1
  });

  it('no next_cursor when the page is not full', async () => {
    const { repo } = repoWith({ findMany: vi.fn().mockResolvedValue([row('a')]) });
    const page = await repo.searchPaged({ tenant_id: 't', page_size: 2 });
    expect(page.next_cursor).toBeNull();
  });

  it('applies the cursor (decoded id + skip:1) on a follow-up page', async () => {
    const { repo, findMany } = repoWith();
    const cursor = Buffer.from('b', 'utf8').toString('base64url');
    await repo.searchPaged({ tenant_id: 't', cursor });
    const call = findMany.mock.calls[0]![0];
    expect(call.cursor).toEqual({ id: 'b' });
    expect(call.skip).toBe(1);
  });

  it('name sort → [last_name, first_name, id]; default → [created_at, id]', async () => {
    const { repo, findMany } = repoWith();
    await repo.searchPaged({ tenant_id: 't', sort: 'name', dir: 'asc' });
    expect(findMany.mock.calls[0]![0].orderBy).toEqual([
      { last_name: 'asc' },
      { first_name: 'asc' },
      { id: 'asc' },
    ]);
    await repo.searchPaged({ tenant_id: 't' });
    expect(findMany.mock.calls[1]![0].orderBy).toEqual([
      { created_at: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('availability "unknown" matches null OR unknown; skills all = AND; owner/allowlist = IN', async () => {
    const { repo, findMany } = repoWith();
    await repo.searchPaged({
      tenant_id: 't',
      availability_status: ['unknown', 'available_now'],
      skills: ['rust', 'go'],
      skill_match: 'all',
      owner_id: ['u1'],
      id_allowlist: ['x', 'y'],
    });
    const where = findMany.mock.calls[0]![0].where;
    expect(where.owner_id).toEqual({ in: ['u1'] });
    expect(where.id).toEqual({ in: ['x', 'y'] });
    // unknown availability → an OR(null, in) clause in AND
    const andClauses = where.AND as Array<Record<string, unknown>>;
    expect(andClauses).toEqual(
      expect.arrayContaining([
        { OR: [{ availability_status: { in: ['unknown', 'available_now'] } }, { availability_status: null }] },
        { AND: [{ key_skills: { contains: 'rust', mode: 'insensitive' } }, { key_skills: { contains: 'go', mode: 'insensitive' } }] },
      ]),
    );
  });

  it('computes full-set native facet counts (null availability folds into unknown)', async () => {
    const { repo } = repoWith({
      groupBy: vi
        .fn()
        .mockResolvedValueOnce([
          { availability_status: 'available_now', _count: { _all: 3 } },
          { availability_status: null, _count: { _all: 2 } },
          { availability_status: 'unknown', _count: { _all: 1 } },
        ]) // availability
        .mockResolvedValueOnce([{ engagement_type: 'contract', _count: { _all: 4 } }]) // engagement
        .mockResolvedValueOnce([{ source: 'Referral', _count: { _all: 5 } }]), // source
      count: vi.fn().mockResolvedValue(7),
    });
    const page = await repo.searchPaged({ tenant_id: 't' });
    expect(page.facets.availability.find((b) => b.value === 'unknown')?.count).toBe(3); // null(2)+unknown(1)
    expect(page.facets.availability.find((b) => b.value === 'available_now')?.count).toBe(3);
    expect(page.facets.engagement[0]).toEqual({ value: 'contract', count: 4 });
    expect(page.facets.source[0]).toEqual({ value: 'Referral', count: 5 });
    expect(page.facets.hot).toBe(7);
  });
});
