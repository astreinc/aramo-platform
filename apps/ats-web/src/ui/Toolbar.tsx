import type { ReactNode } from 'react';
import { IconSearch } from '@aramo/fe-foundation';

interface ToolbarProps {
  readonly children: ReactNode;
}

// A card-edge toolbar row: filter chips on the left, a scoped search on the
// right (the mockup list grammar).
export function Toolbar({ children }: ToolbarProps) {
  return <div className="rc-toolbar">{children}</div>;
}

interface FilterChipProps {
  readonly active?: boolean;
  readonly onClick?: () => void;
  readonly icon?: ReactNode;
  /** Render as a non-interactive, greyed chip (e.g. a reserved/coming-soon
   * filter). Disabled chips are never `active` and fire no onClick. */
  readonly disabled?: boolean;
  readonly title?: string;
  readonly children: ReactNode;
}

export function FilterChip({
  active = false,
  onClick,
  icon,
  disabled = false,
  title,
  children,
}: FilterChipProps) {
  return (
    <button
      type="button"
      className={`rc-chip${active && !disabled ? ' rc-chip--on' : ''}${disabled ? ' rc-chip--disabled' : ''}`}
      aria-pressed={disabled ? undefined : active}
      disabled={disabled}
      {...(title !== undefined ? { title } : {})}
      onClick={disabled ? undefined : onClick}
    >
      {icon}
      {children}
    </button>
  );
}

interface ScopedSearchProps {
  readonly placeholder?: string;
  readonly value?: string;
  readonly onChange?: (value: string) => void;
}

// A scoped, in-context search input ("Search your talent", "In this
// pipeline"). When uncontrolled (no onChange) it renders a visual affordance
// only — wiring is per-surface. NOTE (G3): this is scoped to the recruiter's
// consented working set; it is NOT open-web talent search.
export function ScopedSearch({ placeholder = 'Search', value, onChange }: ScopedSearchProps) {
  if (onChange) {
    return (
      <label className="rc-scopedsearch">
        <IconSearch />
        <input
          type="search"
          value={value ?? ''}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          aria-label={placeholder}
          style={{ border: 0, outline: 'none', background: 'transparent', width: '100%', font: 'inherit', color: 'inherit' }}
        />
      </label>
    );
  }
  return (
    <span className="rc-scopedsearch" role="search" aria-label={placeholder}>
      <IconSearch />
      {placeholder}
    </span>
  );
}
