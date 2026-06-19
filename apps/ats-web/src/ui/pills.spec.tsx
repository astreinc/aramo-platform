import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ConstraintChip, StagePill, StatusPill, TagList } from './pills';

describe('StatusPill', () => {
  it('applies the tone class and renders children', () => {
    const { container } = render(<StatusPill tone="ok" dot>Open</StatusPill>);
    const pill = container.firstChild as HTMLElement;
    expect(pill.className).toContain('rc-pill--ok');
    expect(pill.className).toContain('rc-pill__dot');
    expect(screen.getByText('Open')).toBeInTheDocument();
  });
});

describe('StagePill', () => {
  it('renders the recruiter label with the mapped tone', () => {
    const { container } = render(<StagePill status="submitted" />);
    const pill = container.firstChild as HTMLElement;
    expect(pill.textContent).toBe('Submitted');
    expect(pill.className).toContain('rc-pill--brand');
  });

  it('tones a terminal-reject stage as danger', () => {
    const { container } = render(<StagePill status="client_declined" />);
    expect((container.firstChild as HTMLElement).className).toContain('rc-pill--danger');
  });
});

describe('TagList', () => {
  it('renders all tags when under the max', () => {
    render(<TagList tags={['Rust', 'Go']} />);
    expect(screen.getByText('Rust')).toBeInTheDocument();
    expect(screen.getByText('Go')).toBeInTheDocument();
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it('collapses the remainder into a +N tag', () => {
    render(<TagList tags={['Rust', 'Go', 'Kafka', 'AWS', 'K8s']} max={3} />);
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.queryByText('AWS')).not.toBeInTheDocument();
  });
});

describe('ConstraintChip', () => {
  it('applies the state class', () => {
    const { container } = render(
      <ConstraintChip state="partial" label="Location" value="Remote · confirm" />,
    );
    expect((container.firstChild as HTMLElement).className).toContain('rc-constraint--partial');
    expect(screen.getByText('Location')).toBeInTheDocument();
    expect(screen.getByText('Remote · confirm')).toBeInTheDocument();
  });
});
