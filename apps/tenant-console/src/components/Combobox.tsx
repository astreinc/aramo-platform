import * as RadixPopover from '@radix-ui/react-popover';
import { useEffect, useMemo, useRef, useState } from 'react';

// Settings S5c-2 — Combobox (the shared searchable-select primitive).
//
// PL-94 §2 ruling 1 — built on @radix-ui/react-popover (anchor +
// positioning + outside-click + escape; the hard parts ship). The
// search input + filter list + ARIA combobox semantics are hand-
// built on top.
//
// PL-94 §2 ruling 2 — GENERIC INTERFACE. The Combobox knows nothing
// about users, teams, or companies. Its item set is `{value, label,
// description?, disabled?}` over ANY labeled set; S5c-2 feeds it
// tenant users; S5c-3 will feed it tenant companies unmodified. The
// FILTER + the non-member exclusion live at the CONSUMER (the
// Combobox stays generic).
//
// ARIA COMBOBOX (PL-94 §2 ruling 5 inherited from S5c-1 — hand-built):
//   - trigger button: role="combobox" + aria-expanded + aria-haspopup
//   - results list: role="listbox" + role="option" per item +
//     aria-selected
//   - keyboard: ↓ open / next; ↑ prev; Enter select highlighted; Esc
//     close; type-to-filter
//   - the highlighted-index state lets keyboard nav move through the
//     filtered set without losing focus from the search input

export interface ComboboxItem {
  /** Underlying id (user_id / company_id / …). */
  readonly value: string;
  /** Primary display. */
  readonly label: string;
  /** Optional secondary display (email / address). */
  readonly description?: string;
  /** Greyed out, unselectable. Default false. */
  readonly disabled?: boolean;
}

export interface ComboboxProps {
  /**
   * The full item set. The CONSUMER pre-filters (e.g. non-members);
   * the Combobox does not know item domain semantics.
   */
  readonly items: ReadonlyArray<ComboboxItem>;
  /** Selected value (the item's `value`), or null when nothing chosen. */
  readonly value: string | null;
  /** Fires when an item is selected (Enter or click). */
  readonly onSelect: (item: ComboboxItem) => void;
  /** Placeholder shown in the trigger when nothing is selected. */
  readonly placeholder?: string;
  /** Shown when the filtered set is empty. */
  readonly emptyMessage?: string;
  /** Accessible name for the combobox + listbox. */
  readonly ariaLabel: string;
  /** Disable the whole control. */
  readonly disabled?: boolean;
  /** Optional test seam — applied to the trigger button. */
  readonly testId?: string;
}

function matchesQuery(item: ComboboxItem, query: string): boolean {
  if (query.length === 0) return true;
  const q = query.toLowerCase();
  if (item.label.toLowerCase().includes(q)) return true;
  if (item.description !== undefined && item.description.toLowerCase().includes(q)) {
    return true;
  }
  return false;
}

export function Combobox({
  items,
  value,
  onSelect,
  placeholder = 'Select…',
  emptyMessage = 'No matches.',
  ariaLabel,
  disabled = false,
  testId,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxIdRef = useRef(
    `combobox-listbox-${Math.random().toString(36).slice(2, 8)}`,
  );

  const filtered = useMemo(
    () => items.filter((item) => matchesQuery(item, query)),
    [items, query],
  );

  const selectedItem = useMemo(
    () => items.find((i) => i.value === value) ?? null,
    [items, value],
  );

  // Reset query + highlight when the popover opens/closes.
  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlighted(0);
      // Focus the search input shortly after open — Radix Portal needs
      // a tick to mount.
      const id = requestAnimationFrame(() => searchRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [open]);

  const clampedHighlight = Math.min(highlighted, Math.max(filtered.length - 1, 0));

  const onKeyDown = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (filtered.length === 0) {
      if (ev.key === 'Escape') setOpen(false);
      return;
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setHighlighted((h) => Math.min(filtered.length - 1, h + 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setHighlighted((h) => Math.max(0, h - 1));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const target = filtered[clampedHighlight];
      if (target !== undefined && target.disabled !== true) {
        onSelect(target);
        setOpen(false);
      }
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      setOpen(false);
    }
  };

  const handleSelect = (item: ComboboxItem) => {
    if (item.disabled === true) return;
    onSelect(item);
    setOpen(false);
  };

  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={listboxIdRef.current}
          aria-label={ariaLabel}
          disabled={disabled}
          className="tc-combobox-trigger"
          data-testid={testId}
        >
          <span
            className={
              selectedItem === null
                ? 'tc-combobox-trigger__placeholder'
                : 'tc-combobox-trigger__label'
            }
          >
            {selectedItem === null ? placeholder : selectedItem.label}
          </span>
          <span aria-hidden="true" className="tc-combobox-trigger__chevron">
            ▾
          </span>
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className="tc-combobox__content"
          sideOffset={4}
          align="start"
        >
          <div className="tc-combobox__search">
            <input
              ref={searchRef}
              type="text"
              className="tc-combobox__input"
              placeholder="Search…"
              value={query}
              onChange={(ev) => {
                setQuery(ev.target.value);
                setHighlighted(0);
              }}
              onKeyDown={onKeyDown}
              aria-label="Search"
              aria-autocomplete="list"
              aria-controls={listboxIdRef.current}
              data-testid={testId !== undefined ? `${testId}-search` : undefined}
            />
          </div>
          <ul
            id={listboxIdRef.current}
            role="listbox"
            aria-label={ariaLabel}
            className="tc-combobox__listbox"
          >
            {filtered.length === 0 ? (
              <li className="tc-combobox__empty">{emptyMessage}</li>
            ) : (
              filtered.map((item, idx) => {
                const isSelected = item.value === value;
                const isHighlighted = idx === clampedHighlight;
                return (
                  <li
                    key={item.value}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={item.disabled === true ? true : undefined}
                    data-highlighted={isHighlighted ? 'true' : undefined}
                    className="tc-combobox__option"
                    onMouseEnter={() => setHighlighted(idx)}
                    onClick={() => handleSelect(item)}
                    data-testid={
                      testId !== undefined
                        ? `${testId}-option-${item.value}`
                        : undefined
                    }
                  >
                    <span className="tc-combobox__option-label">
                      {item.label}
                    </span>
                    {item.description !== undefined && (
                      <span className="tc-combobox__option-description">
                        {item.description}
                      </span>
                    )}
                  </li>
                );
              })
            )}
          </ul>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
