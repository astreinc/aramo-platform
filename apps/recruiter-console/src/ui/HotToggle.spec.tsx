import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HotToggle } from './HotToggle';

describe('HotToggle (is_hot row triage)', () => {
  it('reflects hot state via aria-pressed + title', () => {
    render(<HotToggle hot onToggle={() => undefined} label="Marcus" />);
    const btn = screen.getByRole('button', { name: /Marcus is marked hot/ });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveAttribute('title', expect.stringContaining('unmark'));
  });

  it('not-hot announces the mark action', () => {
    render(<HotToggle hot={false} onToggle={() => undefined} label="Sofia" />);
    const btn = screen.getByRole('button', { name: /Mark Sofia as hot/ });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking flips the value', () => {
    const onToggle = vi.fn();
    render(<HotToggle hot={false} onToggle={onToggle} label="x" />);
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('read-only (no onToggle) is disabled but still shows state', () => {
    render(<HotToggle hot label="y" />);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });
});
