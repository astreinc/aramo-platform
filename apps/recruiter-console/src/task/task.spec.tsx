import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Session } from '@aramo/fe-foundation';

import { TaskList } from './TaskList';
import { isAssigneeError, taskMutateErrorMessage } from './error-messages';
import type { TaskView } from './types';
import {
  createTask,
  listMyTasks,
  listTasksForOwner,
  probeTenantUsers,
  updateTask,
} from './task-api';
import { TasksPanel } from './TasksPanel';
import { MyTasksView } from './MyTasksView';
import { TaskDialog } from './TaskDialog';

// vitest hoists vi.mock above the imports, so the mocked './task-api' applies
// even though it's declared below them (keeps the import group contiguous).
vi.mock('./task-api', () => ({
  listMyTasks: vi.fn(),
  listTasksForOwner: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  probeTenantUsers: vi.fn(),
}));

function session(scopes: readonly string[]): Session {
  return {
    sub: 'u1',
    consumer_type: 'recruiter',
    tenant_id: 't',
    scopes: [...scopes],
    iat: 0,
    exp: 0,
  } as Session;
}

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't1',
    tenant_id: 't',
    title: 'Call talent',
    description: null,
    due_date: '2026-06-12T00:00:00.000Z',
    status: 'open',
    assignee_id: null,
    created_by_user_id: 'u1',
    owner_type: 'talent_record',
    owner_id: 'tal-1',
    created_at: '2026-06-09T00:00:00.000Z',
    updated_at: '2026-06-09T00:00:00.000Z',
    ...over,
  };
}

afterEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// PROOF #4 (read-only posture) — TaskList renders controls ONLY when canWrite.
// ---------------------------------------------------------------------------
describe('TaskList — write-gated controls (Ruling 4)', () => {
  const noop = () => undefined;
  it('canWrite=false → rows render, NO controls', () => {
    render(
      <TaskList items={[task()]} canWrite={false} onToggleStatus={noop} onEdit={noop} onDelete={noop} emptyMessage="none" />,
    );
    expect(screen.getByText('Call talent')).toBeInTheDocument();
    expect(screen.queryByTestId('task-toggle')).toBeNull();
    expect(screen.queryByTestId('task-edit')).toBeNull();
    expect(screen.queryByTestId('task-delete')).toBeNull();
  });
  it('canWrite=true → toggle/edit/delete controls render', () => {
    render(
      <TaskList items={[task()]} canWrite onToggleStatus={noop} onEdit={noop} onDelete={noop} emptyMessage="none" />,
    );
    expect(screen.getByTestId('task-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('task-edit')).toBeInTheDocument();
    expect(screen.getByTestId('task-delete')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// PROOF #5 (assignee 422 surface).
// ---------------------------------------------------------------------------
describe('error-messages — the 422 assignee surface (Ruling 5)', () => {
  it('isAssigneeError true only for 422 + reason=assignee_not_active_tenant_member', () => {
    expect(
      isAssigneeError(new ApiError(422, 'bad', 'VALIDATION_ERROR', { reason: 'assignee_not_active_tenant_member' })),
    ).toBe(true);
    expect(isAssigneeError(new ApiError(422, 'bad', 'VALIDATION_ERROR', { reason: 'other' }))).toBe(false);
    expect(isAssigneeError(new ApiError(404, 'nf'))).toBe(false);
  });
  it('a 404 (owner not visible) maps to an honest message', () => {
    expect(taskMutateErrorMessage(new ApiError(404, 'nf'))).toMatch(/no longer visible/i);
  });
});

// ---------------------------------------------------------------------------
// PROOF #1 — /tasks (MyTasksView) lists my-tasks (assignee=me).
// ---------------------------------------------------------------------------
describe('MyTasksView — my-tasks (Ruling 1)', () => {
  it('fetches listMyTasks (default open) and renders rows', async () => {
    vi.mocked(listMyTasks).mockResolvedValue({ items: [task({ title: 'Follow up' })] });
    vi.mocked(probeTenantUsers).mockResolvedValue({ available: false, items: [] });
    render(
      <MemoryRouter>
        <MyTasksView sessionOverride={session(['task:read', 'task:write'])} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Follow up')).toBeInTheDocument());
    expect(vi.mocked(listMyTasks)).toHaveBeenCalledWith('open');
  });
});

// ---------------------------------------------------------------------------
// PROOF #2 — the per-entity Tasks tab lists ?owner_type&owner_id; render-what-
// arrives (no client filtering).
// ---------------------------------------------------------------------------
describe('TasksPanel — by-entity (Ruling 2 + render-what-arrives)', () => {
  it('lists the entity tasks; canWrite shows New task; renders exactly what arrives', async () => {
    vi.mocked(listTasksForOwner).mockResolvedValue({
      items: [task({ id: 'a', title: 'A' }), task({ id: 'b', title: 'B' })],
    });
    vi.mocked(probeTenantUsers).mockResolvedValue({ available: false, items: [] });
    render(
      <MemoryRouter>
        <TasksPanel ownerType="requisition" ownerId="req-1" canWrite />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('A')).toBeInTheDocument());
    expect(vi.mocked(listTasksForOwner)).toHaveBeenCalledWith('requisition', 'req-1', 'all');
    expect(screen.getByTestId('task-new')).toBeInTheDocument();
    // render-what-arrives: both rows present, no client-side filtering.
    expect(screen.getAllByTestId('task-row')).toHaveLength(2);
  });

  it('read-only actor (canWrite=false) → no New task button, no row controls', async () => {
    vi.mocked(listTasksForOwner).mockResolvedValue({ items: [task()] });
    render(
      <MemoryRouter>
        <TasksPanel ownerType="company" ownerId="co-1" canWrite={false} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Call talent')).toBeInTheDocument());
    expect(screen.queryByTestId('task-new')).toBeNull();
    expect(screen.queryByTestId('task-toggle')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PROOF #3 — create via the Dialog posts {title, owner_type/owner_id from
// context, assignee?}; the assignee fallback when the roster is admin-gated.
// ---------------------------------------------------------------------------
describe('TaskDialog — create (Ruling 3)', () => {
  it('posts owner_type/owner_id from context + title; roster-unavailable → fallback note', async () => {
    vi.mocked(createTask).mockResolvedValue(task());
    const onSaved = vi.fn();
    render(
      <TaskDialog
        open
        onOpenChange={() => undefined}
        mode="create"
        ownerType="talent_record"
        ownerId="tal-1"
        roster={{ available: false, items: [] }}
        onSaved={onSaved}
      />,
    );
    // Roster admin-gated-away → graceful fallback (no Combobox).
    expect(screen.getByTestId('task-assignee-fallback')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Schedule screen' } });
    fireEvent.click(screen.getByTestId('task-save'));
    await waitFor(() => expect(vi.mocked(createTask)).toHaveBeenCalled());
    expect(vi.mocked(createTask)).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Schedule screen',
        owner_type: 'talent_record',
        owner_id: 'tal-1',
      }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('inline assignee error on a 422 assignee rejection', async () => {
    vi.mocked(createTask).mockRejectedValue(
      new ApiError(422, 'bad', 'VALIDATION_ERROR', { reason: 'assignee_not_active_tenant_member' }),
    );
    render(
      <TaskDialog
        open
        onOpenChange={() => undefined}
        mode="create"
        ownerType="company"
        ownerId="co-1"
        roster={{ available: true, items: [{ user_id: 'u9', email: 'x@y', display_name: 'X', is_active: true }] }}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'T' } });
    fireEvent.click(screen.getByTestId('task-save'));
    await waitFor(() =>
      expect(screen.getByText(/assignee is unavailable/i)).toBeInTheDocument(),
    );
  });
});
