import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RollupList } from './RollupList';

describe('RollupList', () => {
  it('renders the total count', () => {
    render(
      <RollupList
        total={15}
        items={[
          { key: 'active', label: 'Active', count: 10 },
          { key: 'on_hold', label: 'On hold', count: 5 },
        ]}
      />,
    );
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('total')).toBeInTheDocument();
  });

  it('renders one row per item with label + count', () => {
    render(
      <RollupList
        total={6}
        items={[
          { key: 'active', label: 'Active', count: 4 },
          { key: 'closed', label: 'Closed', count: 2 },
        ]}
      />,
    );
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders the empty message when items is empty', () => {
    render(
      <RollupList
        total={0}
        items={[]}
        emptyMessage="No data yet."
      />,
    );
    expect(screen.getByText('No data yet.')).toBeInTheDocument();
  });

  it('renders no list when items is empty', () => {
    const { container } = render(
      <RollupList total={0} items={[]} emptyMessage="Nothing here." />,
    );
    expect(
      container.querySelector('.r-home-rollup__list'),
    ).not.toBeInTheDocument();
  });
});
