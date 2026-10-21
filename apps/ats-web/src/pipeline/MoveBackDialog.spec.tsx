import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MoveBackDialog } from './MoveBackDialog';

// Pipeline & RTR Recon Remediation Directive v1.0 §2 R4 (DEF-15(f); D-2) — the backward correction
// needs a note; each stage moves back exactly one step.
describe('MoveBackDialog (R4 / D-2)', () => {
  const confirm = () => screen.getByRole('button', { name: 'Move back' }) as HTMLButtonElement;

  it('targets the previous stage and stays disabled until a note is entered', () => {
    render(<MoveBackDialog open talentName="Ravi" from="qualifying" onOpenChange={vi.fn()} onConfirm={vi.fn()} errorMessage={() => 'x'} />);
    expect(screen.getByText('Move back to Talent responded')).toBeTruthy();
    expect(confirm().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Correction note'), { target: { value: 'Answers still pending' } });
    expect(confirm().disabled).toBe(false);
  });

  it('sends the target and the trimmed note', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<MoveBackDialog open talentName="Ravi" from="talent_responded" onOpenChange={vi.fn()} onConfirm={onConfirm} errorMessage={() => 'x'} />);
    fireEvent.change(screen.getByLabelText('Correction note'), { target: { value: '  Reply was from someone else  ' } });
    fireEvent.click(confirm());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('contacted', 'Reply was from someone else'));
  });

  it('renders nothing for a stage with no backward edge', () => {
    const { container } = render(
      <MoveBackDialog open talentName="Ravi" from="no_contact" onOpenChange={vi.fn()} onConfirm={vi.fn()} errorMessage={() => 'x'} />,
    );
    expect(container.textContent).toBe('');
  });
});
