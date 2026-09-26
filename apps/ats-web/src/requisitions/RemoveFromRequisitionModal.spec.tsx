import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RemoveFromRequisitionModal } from './RemoveFromRequisitionModal';

// Accidental-Add Correction (§15) — the confirmation is a CORRECTION dialog, NOT a generic
// destructive one: it never says "Delete", it states the Talent record is preserved and this
// is not a "Not in consideration" disposition, and the reason is fixed to "Added by mistake".
describe('RemoveFromRequisitionModal', () => {
  const base = { talentName: 'Daniel Cho', busy: false, error: '', onCancel: vi.fn(), onConfirm: vi.fn() };

  it('renders the exact correction copy (name, preservation, not-a-disposition, reason)', () => {
    render(<RemoveFromRequisitionModal {...base} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Remove Daniel Cho from this requisition?')).toBeInTheDocument();
    expect(screen.getByText(/Use this only if the Talent was added by mistake/i)).toBeInTheDocument();
    expect(screen.getByText(/does not delete the Talent record/i)).toBeInTheDocument();
    expect(screen.getByText(/Not in consideration/i)).toBeInTheDocument();
    // Reason is the fixed v1 value.
    expect(screen.getByText('Added by mistake')).toBeInTheDocument();
    // NEVER destructive "Delete" language.
    expect(screen.queryByText(/delete talent/i)).not.toBeInTheDocument();
  });

  it('wires Cancel and Remove from requisition', () => {
    const onCancel = vi.fn(); const onConfirm = vi.fn();
    render(<RemoveFromRequisitionModal {...base} onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from requisition' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('surfaces a typed refusal message and disables actions while busy', () => {
    const { rerender } = render(<RemoveFromRequisitionModal {...base} error="This Talent already has engagement on this requisition, so it can no longer be removed as an accidental add." />);
    expect(screen.getByRole('alert')).toHaveTextContent(/already has engagement/i);
    rerender(<RemoveFromRequisitionModal {...base} busy />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Removing/ })).toBeDisabled();
  });
});
