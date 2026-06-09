import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EngagementTransitionControl } from './EngagementTransitionControl';
import { LEGAL_TRANSITIONS } from './legal-transitions';
import { ENGAGEMENT_STATE_LABELS } from './types';

describe('EngagementTransitionControl', () => {
  it('renders only the legal targets for the current state (load-bearing)', () => {
    render(
      <EngagementTransitionControl from="evaluated" onSubmit={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));

    const menu = screen.getByRole('menu');
    for (const target of LEGAL_TRANSITIONS.evaluated) {
      expect(
        within(menu).getByRole('menuitem', {
          name: ENGAGEMENT_STATE_LABELS[target],
        }),
      ).toBeInTheDocument();
    }
    // The state we came from is NOT offered (no self-loop).
    expect(
      within(menu).queryByRole('menuitem', {
        name: ENGAGEMENT_STATE_LABELS.evaluated,
      }),
    ).not.toBeInTheDocument();
    // A non-adjacent state is NOT offered.
    expect(
      within(menu).queryByRole('menuitem', {
        name: ENGAGEMENT_STATE_LABELS.submitted,
      }),
    ).not.toBeInTheDocument();
  });

  it('renders the Final badge instead of the trigger for terminal states', () => {
    render(<EngagementTransitionControl from="submitted" onSubmit={vi.fn()} />);
    expect(
      screen.queryByRole('button', { name: 'Move to…' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Final')).toBeInTheDocument();
  });

  it('submits the selected target via onSubmit when confirmed', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<EngagementTransitionControl from="engaged" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: ENGAGEMENT_STATE_LABELS.awaiting_response,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));

    expect(onSubmit).toHaveBeenCalledWith('awaiting_response');
  });
});
