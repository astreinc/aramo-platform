import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BulkBar } from './BulkBar';

// CRM-2 — the approved Talent bulk bar is exactly "Add to list" + "Add to
// requisition" (prototype). "Add to list" is permission-gated on saved-list:edit
// (HIDE when absent — never a disabled control naming the scope). Assign-to-me /
// Tag / Start-selection / Export were retired from this bar.

function renderBar(overrides: Partial<Parameters<typeof BulkBar>[0]> = {}) {
  render(
    <BulkBar
      count={2}
      busy={false}
      canManageLists
      onAddToList={vi.fn()}
      onAddToReq={vi.fn()}
      onClear={vi.fn()}
      {...overrides}
    />,
  );
}

describe('BulkBar (CRM-2)', () => {
  it('shows exactly Add to list + Add to requisition (no Assign-to-me / Tag / Start-selection / Export)', () => {
    renderBar();
    expect(
      screen.getByRole('button', { name: /add to list/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /add to requisition/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /assign to me/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^tag$/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /start selection/i }),
    ).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/export/i);
  });

  it('HIDES "Add to list" when saved-list:edit is absent, and never names the scope', () => {
    renderBar({ canManageLists: false });
    expect(
      screen.queryByRole('button', { name: /add to list/i }),
    ).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('saved-list:edit');
    expect(document.body.innerHTML).not.toMatch(/Needs [a-z-]+:[a-z]+/);
    // Add to requisition remains.
    expect(
      screen.getByRole('button', { name: /add to requisition/i }),
    ).toBeInTheDocument();
  });

  it('disables the actions only while a submit is in flight (busy)', () => {
    renderBar({ busy: true });
    expect(screen.getByRole('button', { name: /add to list/i })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /add to requisition/i }),
    ).toBeDisabled();
  });

  it('renders nothing when the selection is empty', () => {
    const { container } = render(
      <BulkBar
        count={0}
        busy={false}
        canManageLists
        onAddToList={vi.fn()}
        onAddToReq={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
