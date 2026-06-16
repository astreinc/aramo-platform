import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActionItem } from './ActionItem';
import { MetricCard } from './MetricCard';
import { ProgressMini } from './ProgressMini';
import { ReservedSeam } from './ReservedSeam';

describe('MetricCard', () => {
  it('renders label, value, and an optional plain hint (no delta arrows)', () => {
    const { container } = render(<MetricCard label="Open reqs" value="12" hint="2 hot" />);
    expect(screen.getByText('Open reqs')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('2 hot')).toBeInTheDocument();
    // No delta semantics class exists — gap #6.
    expect(container.querySelector('[class*="--up"]')).toBeNull();
  });

  it('omits the hint line when not provided', () => {
    const { container } = render(<MetricCard label="Talent" value="47" />);
    expect(container.querySelector('.rc-metric__hint')).toBeNull();
  });
});

describe('ActionItem', () => {
  it('renders the kind icon, title, context, time, and a single action', () => {
    const onAction = vi.fn();
    render(
      <ActionItem
        kind="reply"
        title="Sofia Ramos replied"
        context="…"
        time="5h ago"
        action={
          <button type="button" onClick={onAction}>
            Reply
          </button>
        }
      />,
    );
    expect(screen.getByText('Sofia Ramos replied')).toBeInTheDocument();
    expect(screen.getByText('5h ago')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});

describe('ProgressMini', () => {
  it('exposes the proportion via a progressbar role', () => {
    render(<ProgressMini value={1} max={3} count={1} ariaLabel="Openings" />);
    const bar = screen.getByRole('progressbar', { name: 'Openings' });
    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '3');
  });
});

describe('ReservedSeam', () => {
  it('is a labelled ghosted seam with no scores (R10)', () => {
    render(<ReservedSeam />);
    const seam = screen.getByRole('region', { name: 'Match insight' });
    expect(seam).toBeInTheDocument();
    expect(seam.textContent).toContain('no scores');
    expect(seam.textContent).toContain('Integrates with Core later');
  });
});
