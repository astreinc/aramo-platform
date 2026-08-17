import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EmptyState, ErrorState, LoadingState } from './StateViews';

describe('LoadingState (T10-B2/F-016)', () => {
  it('exposes accessible status semantics with a concise default', () => {
    render(<LoadingState />);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent('Loading…');
  });

  it('accepts an optional context label', () => {
    render(<LoadingState label="Loading users…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading users…');
  });
});

describe('EmptyState (T10-B2/F-016)', () => {
  it('renders domain-specific copy (message + optional title)', () => {
    render(<EmptyState title="No teams" message="Create a team to get started." />);
    const el = screen.getByTestId('empty-state');
    expect(el).toHaveTextContent('No teams');
    expect(el).toHaveTextContent('Create a team to get started.');
  });

  it('renders an optional action seam only when provided', () => {
    const { rerender } = render(<EmptyState message="No results." />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(
      <EmptyState message="No results." action={<button type="button">Clear filters</button>} />,
    );
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });
});

describe('ErrorState (T10-B2/F-013/F-016/F-017)', () => {
  it('renders the (already-safe) message through the canonical alert', () => {
    render(<ErrorState message="Unable to load teams. Try again." />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Unable to load teams. Try again.');
  });

  it('shows no retry control unless onRetry is provided', () => {
    render(<ErrorState message="Unable to load." />);
    expect(screen.queryByTestId('error-retry')).toBeNull();
  });

  it('offers an accessible retry that invokes onRetry', () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Unable to load." onRetry={onRetry} />);
    const btn = screen.getByRole('button', { name: 'Try again' });
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('disables the retry control while retrying (prevents duplicate reads)', () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Unable to load." onRetry={onRetry} retrying />);
    const btn = screen.getByTestId('error-retry');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Retrying…');
    fireEvent.click(btn);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
