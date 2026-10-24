import type { ReactNode } from 'react';
import { Dialog, DialogClose } from '@aramo/fe-foundation';

import { useReturnFocus } from './use-return-focus';
import './platform-components.css';

// PLATFORM-UX-1 F-1 — the right-side detail drawer (handoff §8.1): min(560px,
// 96vw), a lighter overlay, a header (title row + mono subline + ×), a
// scrolling body and an optional action footer. Built on the fe-foundation
// Dialog (Radix): focus is trapped, Esc closes, and focus returns to the
// element that opened it (the row). The drawer geometry is applied by
// platform-components.css, scoped with :has() to dialogs holding `.pw-drawer`.

export interface DetailDrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The header's first line (name + pill). Also the dialog's accessible name. */
  readonly title: ReactNode;
  /** The mono subline under the title (email · id). */
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  /** The action row pinned to the bottom. */
  readonly footer?: ReactNode;
}

export function DetailDrawer({ open, onOpenChange, title, subtitle, children, footer }: DetailDrawerProps) {
  useReturnFocus(open);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={subtitle}
      footer={footer}
    >
      <div className="pw-drawer">
        {children}
        {/* After the content, so focus lands on the first field when the dialog opens. */}
        <DialogClose className="pw-drawer__close" aria-label="Close">
          ×
        </DialogClose>
      </div>
    </Dialog>
  );
}
