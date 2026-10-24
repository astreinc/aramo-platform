import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@aramo/fe-foundation';

import './platform-components.css';

// PLATFORM-UX-1 F-1 — the lifecycle action menu (handoff §6.3): a 1px
// terracotta-outline trigger with a diamond, opening a 300px menu that lists
// only the actions the caller passes (F-5 wires the allowed transitions), each
// with its one-line consequence. Terminal actions read in the danger ink.
// Keyboard: the menu takes focus on open, ↑/↓ move, Esc closes and returns
// focus to the trigger, an outside click closes.

export interface LifecycleMenuAction {
  readonly key: string;
  readonly label: string;
  /** The one-line consequence under the label. */
  readonly description: string;
  /** Default: normal. */
  readonly tone?: 'normal' | 'danger';
}

export interface LifecycleActionMenuProps {
  readonly actions: readonly LifecycleMenuAction[];
  readonly onSelect: (key: string) => void;
  /** The trigger text. Default: "Lifecycle actions". */
  readonly label?: string;
  /** A note under the actions ("Becomes Active automatically…"). */
  readonly footnote?: ReactNode;
}

export function LifecycleActionMenu({
  actions,
  onSelect,
  label = 'Lifecycle actions',
  footnote,
}: LifecycleActionMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = (): HTMLElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (!open) return undefined;
    items()[0]?.focus();
    const onPointer = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(at + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(at - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="pw-lcmenu" ref={wrapRef}>
      <Button
        ref={triggerRef}
        unstyled
        className="pw-lcmenu__trigger"
        aria-haspopup="menu"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="pw-lcmenu__diamond" aria-hidden="true" />
        {/* One text node, as in the design ("Lifecycle actions ▾"): a separate
            flex item would add the 8px gap before the caret, and a split run
            shapes differently. The accessible name stays the plain label. */}
        {`${label} ▾`}
      </Button>
      {open ? (
        <div id={menuId} role="menu" aria-label={label} className="pw-lcmenu__menu" ref={menuRef} onKeyDown={onMenuKey}>
          {actions.map((a) => (
            <Button
              key={a.key}
              unstyled
              role="menuitem"
              className="pw-lcmenu__item"
              onClick={() => {
                // Focus the trigger before the dialog opens: the menu item is
                // about to unmount, so the dialog returns focus to the trigger
                // when it closes (WCAG 2.4.3; H-1 keyboard journey J3).
                close();
                onSelect(a.key);
              }}
            >
              <span className={`pw-lcmenu__label${a.tone === 'danger' ? ' pw-lcmenu__label--danger' : ''}`}>
                {a.label}
              </span>
              <span className="pw-lcmenu__desc">{a.description}</span>
            </Button>
          ))}
          {footnote ? <div className="pw-lcmenu__foot">{footnote}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
