import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Stepper } from './Stepper';

const STEPS = ['Surfaced', 'Engaged', 'Responded', 'Submitted'];

describe('Stepper', () => {
  it('marks earlier steps done and the current step current', () => {
    render(<Stepper steps={STEPS} currentIndex={2} />);
    const phases = screen.getAllByRole('listitem').map((el) => ({
      done: el.className.includes('rc-step--done'),
      cur: el.className.includes('rc-step--cur'),
    }));
    expect(phases).toEqual([
      { done: true, cur: false },
      { done: true, cur: false },
      { done: false, cur: true },
      { done: false, cur: false },
    ]);
    const current = screen.getByText('Responded').closest('li');
    expect(current).toHaveAttribute('aria-current', 'step');
  });

  it('renders every step label', () => {
    render(<Stepper steps={STEPS} currentIndex={0} />);
    for (const label of STEPS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
