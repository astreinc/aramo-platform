import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Avatar, EntityCell, initialsOf } from './Avatar';

describe('initialsOf', () => {
  it('takes first + last initial of a multi-part name', () => {
    expect(initialsOf('Marcus Adeyemi')).toBe('MA');
    expect(initialsOf('  Sofia   Ramos  ')).toBe('SR');
    expect(initialsOf('Ana María Díaz')).toBe('AD');
  });

  it('takes the first two letters of a single name', () => {
    expect(initialsOf('Madonna')).toBe('MA');
  });

  it('falls back to ? for an empty name', () => {
    expect(initialsOf('   ')).toBe('?');
  });
});

describe('Avatar', () => {
  it('renders derived initials', () => {
    render(<Avatar name="Diego Martín" />);
    expect(screen.getByText('DM')).toBeInTheDocument();
  });

  it('honours an explicit initials override', () => {
    render(<Avatar initials="NW" />);
    expect(screen.getByText('NW')).toBeInTheDocument();
  });

  it('maps each size to its rc-av--<size> grammar class', () => {
    // The pixel value lives in ui.css (DDR v1.0 §6: ~34px avatars); jsdom has
    // no box model, so this locks the class token the CSS rule keys on.
    const { container: sm } = render(<Avatar name="A B" size="sm" />);
    const { container: md } = render(<Avatar name="A B" size="md" />);
    const { container: lg } = render(<Avatar name="A B" size="lg" />);
    expect((sm.firstChild as HTMLElement).className).toContain('rc-av--sm');
    expect((md.firstChild as HTMLElement).className).toContain('rc-av--md');
    expect((lg.firstChild as HTMLElement).className).toContain('rc-av--lg');
  });

  it('is deterministic in colour for a given name', () => {
    const { container: a } = render(<Avatar name="Sofia Ramos" />);
    const { container: b } = render(<Avatar name="Sofia Ramos" />);
    const colorA = (a.firstChild as HTMLElement).style.background;
    const colorB = (b.firstChild as HTMLElement).style.background;
    expect(colorA).toBe(colorB);
    expect(colorA).not.toBe('');
  });
});

describe('EntityCell', () => {
  it('renders name, subtitle, and a hot marker when hot', () => {
    render(<EntityCell name="Aisha Khan" subtitle="SRE" hot />);
    expect(screen.getByText('Aisha Khan')).toBeInTheDocument();
    expect(screen.getByText('SRE')).toBeInTheDocument();
    expect(screen.getByLabelText('Hot')).toBeInTheDocument();
  });

  it('omits the hot marker by default', () => {
    render(<EntityCell name="Lena Olsen" />);
    expect(screen.queryByLabelText('Hot')).not.toBeInTheDocument();
  });
});
