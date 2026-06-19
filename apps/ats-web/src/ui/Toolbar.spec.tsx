import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FilterChip, ScopedSearch, Toolbar } from './Toolbar';

describe('FilterChip', () => {
  it('reflects the active state via aria-pressed + class', () => {
    const { rerender, container } = render(<FilterChip active>All</FilterChip>);
    const chip = container.firstChild as HTMLElement;
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip.className).toContain('rc-chip--on');
    rerender(<FilterChip>All</FilterChip>);
    expect(container.firstChild as HTMLElement).toHaveAttribute('aria-pressed', 'false');
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    render(<FilterChip onClick={onClick}>Only mine</FilterChip>);
    fireEvent.click(screen.getByRole('button', { name: 'Only mine' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('ScopedSearch', () => {
  it('is a visual affordance (search role) when uncontrolled', () => {
    render(
      <Toolbar>
        <ScopedSearch placeholder="In this pipeline" />
      </Toolbar>,
    );
    expect(screen.getByRole('search', { name: 'In this pipeline' })).toBeInTheDocument();
  });

  it('is an editable input when controlled', () => {
    const onChange = vi.fn();
    render(<ScopedSearch placeholder="Search your talent" value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search your talent' }), {
      target: { value: 'rust' },
    });
    expect(onChange).toHaveBeenCalledWith('rust');
  });
});
