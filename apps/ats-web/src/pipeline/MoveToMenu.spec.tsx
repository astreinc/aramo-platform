import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LEGAL_TRANSITIONS } from './legal-transitions';
import { MoveToMenu } from './MoveToMenu';
import { PIPELINE_STATUS_LABELS } from './types';

describe('MoveToMenu', () => {
  it('renders only the legal targets for the current status (the load-bearing invariant)', () => {
    render(<MoveToMenu from="qualifying" onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));

    const menu = screen.getByRole('menu');
    // Every legal target appears as a menuitem.
    for (const target of LEGAL_TRANSITIONS.qualifying) {
      expect(
        within(menu).getByRole('menuitem', {
          name: PIPELINE_STATUS_LABELS[target],
        }),
      ).toBeInTheDocument();
    }
    // The status we came from is NOT offered (no self-loop).
    expect(
      within(menu).queryByRole('menuitem', {
        name: PIPELINE_STATUS_LABELS.qualifying,
      }),
    ).not.toBeInTheDocument();
    // A non-adjacent status is NOT offered.
    expect(
      within(menu).queryByRole('menuitem', {
        name: PIPELINE_STATUS_LABELS.offered,
      }),
    ).not.toBeInTheDocument();
  });

  it('renders the Final badge instead of the trigger for terminal statuses', () => {
    render(<MoveToMenu from="placed" onSubmit={vi.fn()} />);
    expect(
      screen.queryByRole('button', { name: 'Move to…' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Final')).toBeInTheDocument();
  });

  it('submits the selected target via onSubmit when confirmed', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<MoveToMenu from="contacted" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: PIPELINE_STATUS_LABELS.talent_responded,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));

    expect(onSubmit).toHaveBeenCalledWith('talent_responded', undefined);
  });
});
