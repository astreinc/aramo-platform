import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Session } from '@aramo/fe-foundation';

import { fetchAssignableUsers } from '../users/users-api';

import { TaskList } from './TaskList';
import { isAssigneeError, taskMutateErrorMessage } from './error-messages';
import type { TaskView } from './types';
import {
  createTask,
  listMyTasks,
  listTasksForOwner,
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

// §5 Auth-Hardening D4 — the task picker now sources the assignee Combobox
// from the recruiter-scoped assignable endpoint (fetchAssignableUsers), not
// the admin roster probe.
vi.mock('../users/users-api', () => ({
  fetchAssignableUsers: vi.fn(),
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
    type: null,
    priority: null,
    source: 'manual',
    assignee_id: null,
    created_by_user_id: 'u1',
    owner_type: 'talent_record',
    owner_id: 'tal-1',
    created_at: '2026-06-09T00:00:00.000Z',
    updated_at: '2026-06-09T00:00:00.000Z',
    ...over,
  };
}

const NOW = new Date('2026-06-17T12:00:00Z');

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
  it('priority dot names the priority by its label, never the raw code', () => {
    render(
      <TaskList items={[task({ priority: 'med' })]} canWrite={false} onToggleStatus={noop} onEdit={noop} onDelete={noop} emptyMessage="none" />,
    );
    expect(screen.getByLabelText('Priority Medium')).toHaveAttribute('title', 'Priority: Medium');
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
describe('MyTasksView — the rebuilt workspace page', () => {
  function renderPage(scopes: readonly string[] = ['task:read', 'task:write']) {
    return render(
      <MemoryRouter>
        <MyTasksView sessionOverride={session(scopes)} nowOverride={NOW} />
      </MemoryRouter>,
    );
  }

  it('fetches the FULL set (status=all) and renders grouped rows + summary', async () => {
    vi.mocked(listMyTasks).mockResolvedValue({
      items: [
        task({ id: 'a', title: 'Chase Vantage', due_date: '2026-06-15T00:00:00.000Z', type: 'follow_up', priority: 'high' }),
        task({ id: 'b', title: 'Screen backend', due_date: '2026-06-18T00:00:00.000Z', type: 'screen', priority: 'med' }),
      ],
    });
    vi.mocked(fetchAssignableUsers).mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Chase Vantage')).toBeInTheDocument());
    expect(vi.mocked(listMyTasks)).toHaveBeenCalledWith('all');
    // summary strip present; quick-add is a disabled seam (no fake ownerless create)
    expect(screen.getByTestId('summary-overdue')).toBeInTheDocument();
    expect(screen.getByTestId('quickadd-seam')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Priority High').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByLabelText('Priority med')).toBeNull();
  });

  it('switches to the Board view (by status)', async () => {
    vi.mocked(listMyTasks).mockResolvedValue({ items: [task({ title: 'Card A', status: 'in_progress' })] });
    vi.mocked(fetchAssignableUsers).mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Card A')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('view-board'));
    expect(screen.getByTestId('tasks-board')).toBeInTheDocument();
    expect(screen.getByTestId('board-card')).toBeInTheDocument();
  });

  it('selecting rows shows the bulk bar; Complete PATCHes each to done', async () => {
    vi.mocked(listMyTasks).mockResolvedValue({
      items: [task({ id: 'x', title: 'X' }), task({ id: 'y', title: 'Y' })],
    });
    vi.mocked(fetchAssignableUsers).mockResolvedValue([]);
    vi.mocked(updateTask).mockResolvedValue(task());
    renderPage();
    await waitFor(() => expect(screen.getByText('X')).toBeInTheDocument());
    const selects = screen.getAllByTestId('task-select');
    fireEvent.click(selects[0]!);
    fireEvent.click(selects[1]!);
    expect(screen.getByTestId('bulk-complete')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('bulk-complete'));
    await waitFor(() => expect(vi.mocked(updateTask)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(updateTask)).toHaveBeenCalledWith('x', { status: 'done' });
    expect(vi.mocked(updateTask)).toHaveBeenCalledWith('y', { status: 'done' });
  });

  it('read-only actor (task:read only) → no row controls, no bulk select', async () => {
    vi.mocked(listMyTasks).mockResolvedValue({ items: [task({ title: 'RO' })] });
    renderPage(['task:read']);
    await waitFor(() => expect(screen.getByText('RO')).toBeInTheDocument());
    expect(screen.queryByTestId('task-select')).toBeNull();
    expect(screen.queryByTestId('task-toggle')).toBeNull();
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
    vi.mocked(fetchAssignableUsers).mockResolvedValue([]);
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
  it('posts owner_type/owner_id from context + title; empty roster still renders the picker (no fallback)', async () => {
    vi.mocked(createTask).mockResolvedValue(task());
    const onSaved = vi.fn();
    render(
      <TaskDialog
        open
        onOpenChange={() => undefined}
        mode="create"
        ownerType="talent_record"
        ownerId="tal-1"
        roster={[]}
        onSaved={onSaved}
      />,
    );
    // §5 D4: the admin-gated 403-fallback is GONE — the picker always renders
    // (an empty roster shows the Combobox's empty state, not a fallback note).
    expect(screen.getByTestId('task-assignee')).toBeInTheDocument();
    expect(screen.queryByTestId('task-assignee-fallback')).not.toBeInTheDocument();
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
        roster={[{ user_id: 'u9', display_name: 'X' }]}
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

// ---------------------------------------------------------------------------
// Requisition Detail — the opt-in card layout (prototype "Tasks on this
// requisition"): title, "+ New task" and footnote INSIDE one card, compact rows.
// ---------------------------------------------------------------------------
describe('TasksPanel — card layout (Requisition Detail)', () => {
  it('renders the title, rows with the assignee name, and the footnote inside one card', async () => {
    vi.mocked(listTasksForOwner).mockResolvedValue({
      items: [task({ title: 'Prepare client submittal', assignee_id: 'u2', due_date: null })],
    });
    vi.mocked(fetchAssignableUsers).mockResolvedValue([{ user_id: 'u2', display_name: 'Deepika' }]);
    const { container } = render(
      <TasksPanel
        ownerType="requisition"
        ownerId="req-1"
        canWrite
        cardTitle="Tasks on this requisition"
        cardFootnote="Tasks consolidate actionable work across lifecycles."
      />,
    );
    expect(await screen.findByText('Prepare client submittal')).toBeInTheDocument();
    expect(await screen.findByText(/assigned to Deepika/)).toBeInTheDocument();
    const card = container.querySelector('.rc-card');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Tasks on this requisition');
    expect(card?.textContent).toContain('Tasks consolidate actionable work across lifecycles.');
    expect(screen.getByRole('button', { name: '+ New task' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open →' })).toBeInTheDocument();
  });

  it('the checkbox completes a task via the authoritative update', async () => {
    vi.mocked(listTasksForOwner).mockResolvedValue({ items: [task()] });
    vi.mocked(fetchAssignableUsers).mockResolvedValue([]);
    vi.mocked(updateTask).mockResolvedValue(task({ status: 'done' }));
    render(<TasksPanel ownerType="requisition" ownerId="req-1" canWrite cardTitle="Tasks on this requisition" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark Call talent done' }));
    await waitFor(() => expect(updateTask).toHaveBeenCalledWith('t1', { status: 'done' }));
  });

  it('a read-only actor sees rows and no controls', async () => {
    vi.mocked(listTasksForOwner).mockResolvedValue({ items: [task()] });
    render(<TasksPanel ownerType="requisition" ownerId="req-1" canWrite={false} cardTitle="Tasks on this requisition" />);
    expect(await screen.findByText('Call talent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ New task' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open →' })).toBeNull();
    expect(screen.queryByTestId('task-toggle')).toBeNull();
  });

  it('shows the empty state inside the card', async () => {
    vi.mocked(listTasksForOwner).mockResolvedValue({ items: [] });
    render(<TasksPanel ownerType="requisition" ownerId="req-1" canWrite={false} cardTitle="Tasks on this requisition" />);
    expect(await screen.findByText('No tasks on this requisition yet.')).toBeInTheDocument();
  });
});
