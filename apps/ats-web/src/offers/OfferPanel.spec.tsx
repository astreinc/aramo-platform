import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OfferPanel } from './OfferPanel';

// Offer Lifecycle (D7) — the panel renders the state + the governed affordances
// gated by (state × offer:* scope), and each fires onAction with the target edge.
const T = ['offer:transition'];

describe('OfferPanel', () => {
  it('SENT + offer:transition → Accept/Decline/Negotiate/Expire/Rescind buttons + the state label', () => {
    render(<OfferPanel state="SENT" scopes={T} onAction={vi.fn()} />);
    expect(screen.getByText('Sent')).toBeTruthy();
    for (const name of ['Negotiate', 'Accept', 'Decline', 'Expire', 'Rescind']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('without offer:transition → no action buttons (scope-gated), state still shown', () => {
    render(<OfferPanel state="SENT" scopes={['offer:create']} onAction={vi.fn()} />);
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('terminal (ACCEPTED) → no action buttons', () => {
    render(<OfferPanel state="ACCEPTED" scopes={T} onAction={vi.fn()} />);
    expect(screen.getByText('Accepted')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('clicking Accept fires onAction targeting ACCEPTED', () => {
    const onAction = vi.fn();
    render(<OfferPanel state="SENT" scopes={T} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0][0]).toMatchObject({ action: 'ACCEPT', toState: 'ACCEPTED' });
  });
});
