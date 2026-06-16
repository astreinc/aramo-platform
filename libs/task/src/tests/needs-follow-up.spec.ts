import { describe, expect, it, vi } from 'vitest';

import { TaskRepository } from '../lib/task.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// Segment 4c — the "Needs follow-up" preset accessor. Read-only, set-based:
// resolves the talent_record ids whose OPEN, due-or-overdue tasks are ASSIGNED
// to the current user (assignee — NOT creator). The talent-record lib filters
// by these ids; this lib never reaches across into talent-record.
describe('TaskRepository.findTalentIdsWithDueOrOverdueTasksForAssignee (Segment 4c)', () => {
  it('scopes by ASSIGNEE (not creator), owner_type, open status + due/overdue; returns distinct talent ids', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { owner_id: 'talent-a' },
      { owner_id: 'talent-b' },
    ]);
    const repo = new TaskRepository({
      task: { findMany },
    } as unknown as PrismaService);
    const asOf = new Date('2026-06-15T23:59:59.999Z');

    const out = await repo.findTalentIdsWithDueOrOverdueTasksForAssignee({
      tenant_id: 'T',
      assignee_id: 'me',
      as_of: asOf,
      limit: 5000,
    });

    expect(out).toEqual(['talent-a', 'talent-b']);
    const arg = findMany.mock.calls[0]![0];
    // ASSIGNEE scoping is the load-bearing assertion — never created_by_user_id.
    expect(arg.where.assignee_id).toBe('me');
    expect(arg.where.created_by_user_id).toBeUndefined();
    expect(arg.where).toMatchObject({
      tenant_id: 'T',
      owner_type: 'talent_record',
      status: 'open', // not-done
      due_date: { not: null, lte: asOf }, // overdue OR due-today
    });
    expect(arg.distinct).toEqual(['owner_id']);
    expect(arg.take).toBe(5001); // limit+1 → over-guard detectable
  });
});
