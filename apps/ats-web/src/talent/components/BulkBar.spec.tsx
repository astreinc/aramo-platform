import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BulkBar } from './BulkBar';

// T10-B3/F-012 — hide-vs-disable canonical rule: a missing WRITE scope HIDES
// the action (never a disabled control that names the scope). Busy is a
// separate, precondition-style disable.

function renderBar(overrides: Partial<Parameters<typeof BulkBar>[0]> = {}) {
  render(
    <BulkBar
      count={2}
      busy={false}
      onAddToReq={vi.fn()}
      onAssignToMe={vi.fn()}
      canAssign
      onClear={vi.fn()}
      {...overrides}
    />,
  );
}

describe('BulkBar hide-vs-disable', () => {
  it('HIDES "Assign to me" when the write scope is absent, and never names the scope', () => {
    renderBar({ canAssign: false });
    expect(
      screen.queryByRole('button', { name: /assign to me/i }),
    ).not.toBeInTheDocument();
    // The missing permission is never revealed (no scope key, no "Needs …:edit").
    expect(document.body.innerHTML).not.toContain('talent:edit');
    expect(document.body.innerHTML).not.toMatch(/Needs [a-z]+:[a-z]+/);
  });

  it('shows "Assign to me" enabled when authorized and idle', () => {
    renderBar({ canAssign: true, busy: false });
    expect(
      screen.getByRole('button', { name: /assign to me/i }),
    ).toBeEnabled();
  });

  it('disables "Assign to me" only while a submit is in flight (busy)', () => {
    renderBar({ canAssign: true, busy: true });
    expect(
      screen.getByRole('button', { name: /assign to me/i }),
    ).toBeDisabled();
  });
});
