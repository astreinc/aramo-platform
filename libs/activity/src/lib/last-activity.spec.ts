import { describe, expect, it, vi } from 'vitest';

import { ActivityRepository } from './activity.repository.js';
import type { PrismaService } from './prisma/prisma.service.js';

describe('ActivityRepository.findLastActivityForTalentIds', () => {
  it('returns talent_record_id → most-recent activity ISO timestamp (one groupBy)', async () => {
    const ts = new Date('2026-06-10T09:00:00.000Z');
    const groupBy = vi.fn().mockResolvedValue([
      { subject_id: 't1', _max: { created_at: ts } },
      { subject_id: 't2', _max: { created_at: null } }, // no usable ts → skipped
    ]);
    const repo = new ActivityRepository({
      activity: { groupBy },
    } as unknown as PrismaService);
    const m = await repo.findLastActivityForTalentIds({
      tenant_id: 't',
      talent_record_ids: ['t1', 't2', 't3'],
    });
    expect(m.get('t1')).toBe(ts.toISOString());
    expect(m.has('t2')).toBe(false);
    expect(m.has('t3')).toBe(false);
    // set-based: one query, scoped to talent_record subjects
    const where = groupBy.mock.calls[0]![0].where;
    expect(where.subject_type).toBe('talent_record');
    expect(where.subject_id.in).toEqual(['t1', 't2', 't3']);
  });

  it('returns empty without querying for an empty id set', async () => {
    const groupBy = vi.fn();
    const repo = new ActivityRepository({
      activity: { groupBy },
    } as unknown as PrismaService);
    const m = await repo.findLastActivityForTalentIds({
      tenant_id: 't',
      talent_record_ids: [],
    });
    expect(m.size).toBe(0);
    expect(groupBy).not.toHaveBeenCalled();
  });
});
