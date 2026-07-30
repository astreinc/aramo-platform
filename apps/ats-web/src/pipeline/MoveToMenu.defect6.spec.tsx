import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MoveToMenu } from './MoveToMenu';

// Defect #6 regression — the pipeline "Move to…" control did nothing in the
// browser. Root cause: the trigger was `Popover.Trigger asChild` wrapping the
// fe-foundation `Button`, a plain function component that does NOT forward its
// ref. Radix's Slot could not attach the anchor ref
// ("Function components cannot be given refs … Primitive.button.Slot"), so the
// Popper had a null reference element, floating-ui never positioned the
// content, and it stayed `visibility: hidden` — the recruiter saw NOTHING.
//
// jsdom has no layout engine, so the menu still "opens" in the DOM and the
// happy-path spec passes even while the browser is broken. The deterministic
// mechanical signature of the defect is the dropped-ref React warning, which
// React emits once per component per module instance — hence this dedicated
// file, so `MoveToMenu` is rendered here first and the warning is not
// pre-consumed by another test.
describe('MoveToMenu — defect #6 (Move To unresponsive)', () => {
  it('forwards the trigger ref so Radix can anchor the popover (no dropped-ref warning)', () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      warnings.push(args.map(String).join(' '));
    });
    try {
      render(<MoveToMenu from="contacted" onSubmit={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
      expect(screen.getByRole('menu')).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }

    const refWarnings = warnings.filter((w) =>
      /cannot be given refs|forwardRef/i.test(w),
    );
    expect(refWarnings).toEqual([]);
  });
});
