import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PutOnHoldDialog } from './PutOnHoldDialog';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §6.4 (S3) — reason + source are required;
// 'vms' is never offered on the manual path.
describe('PutOnHoldDialog (v1.2 §6.4)', () => {
  const confirmButton = () => screen.getByRole('button', { name: 'Put on hold' }) as HTMLButtonElement;

  it('Put on hold stays disabled until a reason and a source are given; VMS is not offered', () => {
    render(<PutOnHoldDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} errorMessage={() => 'x'} />);
    expect(confirmButton().disabled).toBe(true);
    expect(screen.queryByRole('radio', { name: 'VMS' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Hold reason'), { target: { value: 'Client paused' } });
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Client' }));
    expect(confirmButton().disabled).toBe(false);
  });

  it('sends the trimmed reason, the source and null instructions when blank', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(<PutOnHoldDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} errorMessage={() => 'x'} />);
    fireEvent.change(screen.getByLabelText('Hold reason'), { target: { value: '  Budget review  ' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Internal' }));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ reason: 'Budget review', source: 'internal', instructions: null }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('a refusal keeps the dialog open and shows the typed copy', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('refused'));
    const onOpenChange = vi.fn();
    render(
      <PutOnHoldDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} errorMessage={() => 'Typed refusal copy'} />,
    );
    fireEvent.change(screen.getByLabelText('Hold reason'), { target: { value: 'Paused' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Client' }));
    fireEvent.click(confirmButton());
    expect(await screen.findByText('Typed refusal copy')).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
