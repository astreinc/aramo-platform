import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ExpandableText } from './ExpandableText';

// D3 #4 — truncation with an inline expand affordance.
const LONG = 'x'.repeat(200);

describe('ExpandableText', () => {
  it('renders short text verbatim with no toggle', () => {
    render(<ExpandableText text="a short note" limit={64} />);
    expect(screen.getByText('a short note')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('clips long text and toggles More/Less', () => {
    render(<ExpandableText text={LONG} limit={64} />);
    // Clipped: an ellipsis is present and the full string is not.
    expect(screen.queryByText(LONG)).toBeNull();
    const toggle = screen.getByRole('button', { name: 'More' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(screen.getByText(LONG)).toBeTruthy();
    const less = screen.getByRole('button', { name: 'Less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(less);
    expect(screen.queryByText(LONG)).toBeNull();
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy();
  });

  it('treats a note exactly at the limit as short (no toggle)', () => {
    render(<ExpandableText text={'y'.repeat(64)} limit={64} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
