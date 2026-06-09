import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatCard } from './StatCard';

describe('StatCard', () => {
  it('renders the value and the label', () => {
    render(<StatCard label="Companies" value={42} />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Companies')).toBeInTheDocument();
  });

  it('formats large numbers with locale separators', () => {
    render(<StatCard label="Activities" value={12345} />);
    expect(screen.getByText('12,345')).toBeInTheDocument();
  });

  it('renders the optional hint when supplied', () => {
    render(<StatCard label="Placed" value={3} hint="In your view." />);
    expect(screen.getByText('In your view.')).toBeInTheDocument();
  });

  it('omits the hint when not supplied', () => {
    const { container } = render(<StatCard label="Contacts" value={7} />);
    expect(
      container.querySelector('.r-home-stat__hint'),
    ).not.toBeInTheDocument();
  });
});
