import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Stepper } from './Stepper';
import { SUBMITTAL_STATE_LABELS, WIZARD_STEPS } from './types';

describe('Stepper', () => {
  it('renders all 5 mainline steps in order', () => {
    render(<Stepper currentState="created" />);
    const list = screen.getByRole('list', { name: 'Submittal progress' });
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(WIZARD_STEPS.length);
    WIZARD_STEPS.forEach((step, idx) => {
      expect(items[idx]?.textContent).toContain(SUBMITTAL_STATE_LABELS[step]);
    });
  });

  it('marks the current state as aria-current="step"', () => {
    render(<Stepper currentState="ready_for_review" />);
    const current = screen.getByText(/Ready for review/);
    expect(current.closest('li')?.getAttribute('aria-current')).toBe('step');
  });

  it('confirmed surfaces every prior step as completed (✓)', () => {
    const { container } = render(<Stepper currentState="confirmed" />);
    const ticks = container.querySelectorAll('span[aria-hidden="true"]');
    // Every step before "confirmed" shows ✓; "confirmed" is active.
    const tickCount = Array.from(ticks).filter((t) => t.textContent === '✓')
      .length;
    expect(tickCount).toBe(WIZARD_STEPS.length - 1);
  });

  it('revoked surfaces no current step (revoked is NOT a step)', () => {
    render(<Stepper currentState="revoked" />);
    const list = screen.getByRole('list', { name: 'Submittal progress' });
    const items = list.querySelectorAll('li[aria-current="step"]');
    expect(items).toHaveLength(0);
  });
});
