import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { TaskView } from '../types';

import { TaskDrawer } from './TaskDrawer';

// T10-B3/F-037 — the Tasks drawer accessible interaction.

const NOW = new Date('2026-08-10T00:00:00Z');

const TASK: TaskView = {
  id: 't1',
  tenant_id: 'tn',
  title: 'Call the client',
  description: 'Discuss the offer.',
  due_date: null,
  status: 'open',
  type: 'call',
  priority: 'high',
  source: 'manual',
  assignee_id: null,
  created_by_user_id: 'u1',
  owner_type: 'company',
  owner_id: 'c1',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

function renderDrawer(overrides: Partial<Parameters<typeof TaskDrawer>[0]> = {}) {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <TaskDrawer
        task={TASK}
        now={NOW}
        canWrite
        onClose={onClose}
        onToggleDone={vi.fn()}
        onReschedule={vi.fn()}
        onEdit={vi.fn()}
        {...overrides}
      />
    </MemoryRouter>,
  );
  return { onClose };
}

describe('TaskDrawer accessibility (T10-B3/F-037)', () => {
  it('exposes modal dialog semantics and an accessible close control', () => {
    renderDrawer();
    const dialog = screen.getByTestId('task-drawer');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Task detail');
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('moves focus into the drawer (its heading) on open', () => {
    renderDrawer();
    expect(
      screen.getByRole('heading', { name: 'Call the client' }),
    ).toHaveFocus();
  });

  it('closes on Escape', () => {
    const { onClose } = renderDrawer();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('traps Tab focus within the drawer while open', () => {
    renderDrawer();
    const drawer = screen.getByTestId('task-drawer');
    const focusable = drawer.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    // Forward Tab from the last focusable wraps to the first.
    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(first).toHaveFocus();
    // Shift+Tab from the first wraps to the last.
    first.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('restores focus to the trigger when the drawer closes', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <MemoryRouter>
          <button data-testid="trigger" onClick={() => setOpen(true)}>
            Open
          </button>
          <TaskDrawer
            task={open ? TASK : null}
            now={NOW}
            canWrite
            onClose={() => setOpen(false)}
            onToggleDone={vi.fn()}
            onReschedule={vi.fn()}
            onEdit={vi.fn()}
          />
        </MemoryRouter>
      );
    }
    render(<Harness />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    fireEvent.click(trigger); // opens → focus moves into the drawer
    expect(
      screen.getByRole('heading', { name: 'Call the client' }),
    ).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' }); // closes
    expect(trigger).toHaveFocus();
  });
});
