import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTask,
  deleteTask,
  listMyTasks,
  listTasksForOwner,
  probeTenantUsers,
  updateTask,
} from './task-api';

// Tasks FE — the task endpoint URL construction + the roster probe.

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

describe('task-api — probeTenantUsers (the S5c graceful-403 precedent)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('available + active-only when the roster is readable', async () => {
    mockJson({
      items: [
        { user_id: 'u1', email: 'a@x', display_name: 'Ann', is_active: true },
        { user_id: 'u2', email: 'b@x', display_name: null, is_active: false },
      ],
    });
    const r = await probeTenantUsers();
    expect(r.available).toBe(true);
    expect(r.items.map((u) => u.user_id)).toEqual(['u1']); // inactive filtered
  });

  it('403 (non-admin task-writer) → available:false, no throw', async () => {
    mockJson({ code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    const r = await probeTenantUsers();
    expect(r).toEqual({ available: false, items: [] });
  });
});
