import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTask,
  deleteTask,
  listMyTasks,
  listTasksForOwner,
  updateTask,
} from './task-api';

// Tasks FE — the task endpoint URL construction.

function mockJson(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

describe('task-api — URL construction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('#1 listMyTasks targets ?assignee_id=me (+ status)', async () => {
    const spy = mockJson({ items: [] });
    await listMyTasks('open');
    expect(String(spy.mock.calls[0]?.[0])).toBe('/v1/tasks?assignee_id=me&status=open');
  });

  it('#2 listTasksForOwner targets ?owner_type&owner_id', async () => {
    const spy = mockJson({ items: [] });
    await listTasksForOwner('talent_record', 'tal-1', 'all');
    expect(String(spy.mock.calls[0]?.[0])).toBe(
      '/v1/tasks?owner_type=talent_record&owner_id=tal-1&status=all',
    );
  });

  it('create posts /v1/tasks; update PATCHes; delete DELETEs', async () => {
    const spy = mockJson({ id: 't1' });
    await createTask({ title: 'X', owner_type: 'company', owner_id: 'co-1' });
    expect(spy.mock.calls[0]?.[0]).toBe('/v1/tasks');
    expect((spy.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    await updateTask('t1', { status: 'done' });
    expect(spy.mock.calls[1]?.[0]).toBe('/v1/tasks/t1');
    expect((spy.mock.calls[1]?.[1] as RequestInit).method).toBe('PATCH');
    await deleteTask('t1');
    expect(spy.mock.calls[2]?.[0]).toBe('/v1/tasks/t1');
    expect((spy.mock.calls[2]?.[1] as RequestInit).method).toBe('DELETE');
  });
});
