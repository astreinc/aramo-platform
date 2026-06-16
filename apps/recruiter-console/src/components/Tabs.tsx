import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

// Recruiter R3 — hand-built ARIA-compliant Tabs (recruiter-console-LOCAL).
//
// Ruling 4: the foundation has no Tabs primitive; @radix-ui/react-tabs is
// not a root dep; we hand-build here matching the precedents (fe-foundation's
// hand-built Table, the S5c-1 hand-built ARIA Tree). A later promotion to
// libs/fe-foundation is a deliberate decision once broadly reused — NOT
// speculatively on first use. The frozen foundation stays untouched.
//
// ARIA: the WAI-ARIA Authoring Practices "tabs (automatic activation)"
// pattern. role=tablist on the strip, role=tab on each button (aria-selected,
// aria-controls, id), role=tabpanel on each panel (aria-labelledby, id,
// tabindex=0 so the panel itself is focusable for screen readers). Roving
// tabindex on the tabs: the selected tab has tabindex=0, the rest have
// tabindex=-1. Arrow Left/Right navigates (with wrap); Home/End jumps.
//
// Per-tab scope-gating is the CALLER's responsibility — the parent filters
// `items` to the readable subset before passing in. This keeps the Tabs
// component domain-neutral.

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
}

interface TabsProps {
  readonly items: readonly TabItem[];
  readonly ariaLabel: string;
  readonly initialId?: string;
  /** Controlled selection — when provided, the parent owns the active tab
   * (e.g. a header "Edit" action that jumps to a specific tab). Omit for the
   * default uncontrolled behavior. */
  readonly selectedId?: string;
  readonly onSelectedChange?: (id: string) => void;
}

export function Tabs({
  items,
  ariaLabel,
  initialId,
  selectedId,
  onSelectedChange,
}: TabsProps) {
  const reactId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const initial =
    initialId !== undefined && items.some((t) => t.id === initialId)
      ? initialId
      : items[0]?.id ?? '';
  const [internalSelected, setInternalSelected] = useState(initial);
  const selected = selectedId ?? internalSelected;
  const setSelected = (id: string) => {
    setInternalSelected(id);
    onSelectedChange?.(id);
  };

  if (items.length === 0) {
    return null;
  }

  const focus = (index: number) => {
    const clamped = (index + items.length) % items.length;
    const next = items[clamped];
    if (next === undefined) return;
    setSelected(next.id);
    tabRefs.current[clamped]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focus(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focus(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focus(0);
        break;
      case 'End':
        event.preventDefault();
        focus(items.length - 1);
        break;
      default:
        break;
    }
  };

  const tabId = (id: string) => `${reactId}-tab-${id}`;
  const panelId = (id: string) => `${reactId}-panel-${id}`;

  return (
    <div className="tabs">
      <div className="tabs__list" role="tablist" aria-label={ariaLabel}>
        {items.map((tab, index) => {
          const isSelected = tab.id === selected;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={isSelected}
              aria-controls={panelId(tab.id)}
              tabIndex={isSelected ? 0 : -1}
              className="tabs__tab"
              data-selected={isSelected ? 'true' : 'false'}
              onClick={() => setSelected(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {items.map((tab) => {
        const isSelected = tab.id === selected;
        return (
          <div
            key={tab.id}
            role="tabpanel"
            id={panelId(tab.id)}
            aria-labelledby={tabId(tab.id)}
            hidden={!isSelected}
            tabIndex={0}
            className="tabs__panel"
          >
            {isSelected ? tab.content : null}
          </div>
        );
      })}
    </div>
  );
}
