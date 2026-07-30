import { render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';

import { Button } from './Button';

describe('Button — ref forwarding (shared chrome)', () => {
  it('forwards its ref to the underlying <button> DOM node', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Click</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.tagName).toBe('BUTTON');
    expect(ref.current?.textContent).toBe('Click');
  });

  it('renders byte-identical DOM (class + type) — the change is purely additive', () => {
    const { getByRole } = render(
      <Button variant="secondary" size="sm">
        Go
      </Button>,
    );
    const btn = getByRole('button', { name: 'Go' });
    expect(btn.getAttribute('class')).toBe(
      'tc-button tc-button--secondary tc-button--sm',
    );
    expect(btn.getAttribute('type')).toBe('button');
  });
});
