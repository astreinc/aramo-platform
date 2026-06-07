import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

// Settings S5b — Dialog wrapper around Radix's headless dialog primitive.
//
// Why Radix here (vs. hand-built like Table): a modal dialog needs a
// focus trap, escape-to-close, scroll-lock, the inert-outside semantics,
// and the aria wiring — every one of which is fiddly to get right by
// hand. Radix ships the primitive that already passes the a11y audit.
//
// The wrapper deliberately keeps the API tiny: the caller decides open
// state (controlled) and passes a title + description + body + footer.
// The whole point of a wrapper is so InviteDialog / DisableConfirmDialog
// don't each repeat the Overlay + Content + Title + Description scaffold.
//
// All Radix Dialog instances render into the same portal — the toast
// viewport stays untouched. The Overlay is a full-screen scrim; the
// Content centers + clips to the visible viewport.

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  // Sizes follow the existing density tokens. 'sm' for confirms, 'md'
  // for forms (the default), 'lg' for the role-assign editor.
  size?: 'sm' | 'md' | 'lg';
}

const sizeClass: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'tc-dialog__content--sm',
  md: '',
  lg: 'tc-dialog__content--lg',
};

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: DialogProps) {
  const classes = ['tc-dialog__content', sizeClass[size]]
    .filter(Boolean)
    .join(' ');

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="tc-dialog__overlay" />
        <RadixDialog.Content className={classes}>
          <RadixDialog.Title className="tc-dialog__title">
            {title}
          </RadixDialog.Title>
          {description !== undefined && (
            <RadixDialog.Description className="tc-dialog__description">
              {description}
            </RadixDialog.Description>
          )}
          <div className="tc-dialog__body">{children}</div>
          {footer !== undefined && (
            <div className="tc-dialog__footer">{footer}</div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;
