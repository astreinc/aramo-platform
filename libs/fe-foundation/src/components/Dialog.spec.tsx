import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Dialog } from './Dialog';

// The Dialog wrapper maps its `size` prop to a content class. Sizes are additive
// tokens: 'sm' | 'md' (default, no modifier) | 'lg' | 'xl'. 'xl' (G2.3) is the
// wide review/compose surface with a fixed header/footer + scrollable body.
describe('Dialog size', () => {
  function contentEl(): HTMLElement | null {
    return document.querySelector('.tc-dialog__content');
  }

  it('default (md) applies only the base content class', () => {
    render(
      <Dialog open onOpenChange={() => undefined} title="T">
        body
      </Dialog>,
    );
    const el = contentEl();
    expect(el).not.toBeNull();
    expect(el?.classList.contains('tc-dialog__content--xl')).toBe(false);
    expect(el?.classList.contains('tc-dialog__content--lg')).toBe(false);
  });

  it('size="xl" applies the xl content modifier (wide review/compose surface)', () => {
    render(
      <Dialog open onOpenChange={() => undefined} title="Review email draft" size="xl">
        body
      </Dialog>,
    );
    expect(screen.getByText('Review email draft')).toBeInTheDocument();
    expect(contentEl()?.classList.contains('tc-dialog__content--xl')).toBe(true);
  });
});
