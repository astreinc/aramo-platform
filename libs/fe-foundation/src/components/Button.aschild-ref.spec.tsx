import * as RadixPopover from '@radix-ui/react-popover';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button';

// PR-A regression (shared chrome). fe-foundation Button must forward its ref so
// Radix `asChild` primitives can attach the trigger/anchor ref. A plain
// function component drops it ("Function components cannot be given refs …
// Primitive.button.Slot"), leaving a Radix Popover trigger with a null anchor —
// the content never positions and stays `visibility: hidden` in the browser
// (defect #6, and its twin apps/ats-web/src/engagement/EngagementTransitionControl).
//
// This lives in its OWN spec file on purpose: React emits the dropped-ref
// warning once per component per module instance, so nothing may render Button
// before this test or the signal would be pre-consumed.
describe('Button under Radix asChild — no dropped ref', () => {
  it('does not emit a dropped-ref warning as a Popover.Trigger child', () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      warnings.push(args.map(String).join(' '));
    });
    try {
      render(
        <RadixPopover.Root>
          <RadixPopover.Trigger asChild>
            <Button variant="secondary" size="sm">
              Open
            </Button>
          </RadixPopover.Trigger>
          <RadixPopover.Portal>
            <RadixPopover.Content>panel</RadixPopover.Content>
          </RadixPopover.Portal>
        </RadixPopover.Root>,
      );
      expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }

    const refWarnings = warnings.filter((w) =>
      /cannot be given refs|forwardRef/i.test(w),
    );
    expect(refWarnings).toEqual([]);
  });
});
