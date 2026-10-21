import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NotInConsiderationDialog } from './NotInConsiderationDialog';

// Pipeline & RTR Recon Remediation Directive v1.0 §2 R1 (DEF-6) — a reason is required; the
// authority class is derived from the chosen reason; system (downstream) reasons are never offered.
describe('NotInConsiderationDialog (R1 / DEF-6)', () => {
  const confirm = () => screen.getByRole('button', { name: 'Mark Not in consideration' }) as HTMLButtonElement;

  it('the action stays disabled until a reason is chosen; only the 12 recruiter reasons are offered', () => {
    render(<NotInConsiderationDialog open talentName="Ravi" onOpenChange={vi.fn()} onConfirm={vi.fn()} errorMessage={() => 'x'} />);
    expect(confirm().disabled).toBe(true);
    expect(screen.getAllByRole('radio')).toHaveLength(12);
    expect(screen.queryByRole('radio', { name: 'Placement fell through' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Talent declined' }));
    expect(confirm().disabled).toBe(false);
  });

  it('sends the reason with its authority class and the trimmed note, then closes', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(<NotInConsiderationDialog open talentName="Ravi" onOpenChange={onOpenChange} onConfirm={onConfirm} errorMessage={() => 'x'} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Position filled externally' }));
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: '  Client hired internally  ' } });
    fireEvent.click(confirm());
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        authority_class: 'ENGAGEMENT',
        reason: 'position_filled_externally',
        note: 'Client hired internally',
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('a refusal stays open and shows the typed copy', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('refused'));
    const onOpenChange = vi.fn();
    render(<NotInConsiderationDialog open talentName="Ravi" onOpenChange={onOpenChange} onConfirm={onConfirm} errorMessage={() => 'Typed refusal'} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Not a fit' }));
    fireEvent.click(confirm());
    expect(await screen.findByText('Typed refusal')).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
