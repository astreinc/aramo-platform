import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@aramo/fe-foundation';

import type { OperatorIdentity } from '../identity/identity';

import { ChevronIcon } from './nav-icons';

// PLATFORM-UX-1 F-2 — the account menu (handoff §3.4): a 30px midnight avatar
// trigger opening a 290px menu with the identity (36px avatar, name, mono
// email, role badge + tenant), then "Sign in with a different account" and
// "Sign out". Built locally: UserMenu's fixed panel cannot render the designed
// identity block (avatar inside the panel, badge + tenant row, icon-less rows).

export interface AccountMenuProps {
  readonly identity: OperatorIdentity;
  readonly onSwitchAccount: () => void;
  readonly onSignOut: () => void;
}

export function AccountMenu({ identity, onSwitchAccount, onSignOut }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
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
    <div className="pw-account" ref={wrapRef}>
      <Button
        ref={triggerRef}
        unstyled
        className="pw-account__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${identity.name}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="pw-account__avatar" aria-hidden="true">
          {identity.initials}
        </span>
        <ChevronIcon />
      </Button>
      {open ? (
        <div className="pw-account__menu" role="menu" aria-label="Account" ref={menuRef} onKeyDown={onKey}>
          <div className="pw-account__id">
            <span className="pw-account__avatar pw-account__avatar--lg" aria-hidden="true">
              {identity.initials}
            </span>
            <span className="pw-account__who">
              <span className="pw-account__name">{identity.name}</span>
              <span className="pw-account__email">{identity.email}</span>
              <span className="pw-account__meta">
                {identity.role ? <span className="pw-account__role">{identity.role.toUpperCase()}</span> : null}
                <span className="pw-account__tenant">{identity.tenant}</span>
              </span>
            </span>
          </div>
          <div className="pw-account__rule" />
          <Button
            unstyled
            role="menuitem"
            className="pw-account__item"
            onClick={() => {
              setOpen(false);
              onSwitchAccount();
            }}
          >
            Sign in with a different account
          </Button>
          <Button
            unstyled
            role="menuitem"
            className="pw-account__item pw-account__item--signout"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            Sign out
          </Button>
        </div>
      ) : null}
    </div>
  );
}
