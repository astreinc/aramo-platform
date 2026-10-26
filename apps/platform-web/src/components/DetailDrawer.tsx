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
  /**
   * CCP-B1: `ccp` is the CCP-UI v1.0 change-request drawer (handoff §5.2):
   * min(640px, 96vw), the subtitle row (id + pill) above an 18px title, a 16px 20px
   * body and the #FAFBFC footer. Default: the PLATFORM-UX-1 drawer, unchanged.
   */
  readonly variant?: 'default' | 'ccp';
}

export function DetailDrawer({ open, onOpenChange, title, subtitle, children, footer, variant = 'default' }: DetailDrawerProps) {
  useReturnFocus(open);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={subtitle}
      footer={footer}
    >
      <div className={variant === 'ccp' ? 'pw-drawer pw-drawer--ccp' : 'pw-drawer'}>
        {children}
        {/* After the content, so focus lands on the first field when the dialog opens. */}
        <DialogClose className="pw-drawer__close" aria-label="Close">
          {variant === 'ccp' ? '✕' : '×'}
        </DialogClose>
      </div>
    </Dialog>
  );
}
