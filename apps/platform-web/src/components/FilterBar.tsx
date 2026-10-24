import type { ReactNode } from 'react';
import { Button } from '@aramo/fe-foundation';

import './platform-components.css';

// PLATFORM-UX-1 F-1 — the filter bar (handoff §3.6): a segmented group with
// per-option counts, then the caller's Select / search Input, then a result
// count on the right. The segmented items are toggle buttons (aria-pressed,
// handoff §15).

export interface SegmentOption<V extends string = string> {
  readonly value: V;
  readonly label: string;
  /** The mono count after the label; omit to show none. */
  readonly count?: number;
}

export interface SegmentedFilterProps<V extends string = string> {
  /** The group's accessible name ("Status"). */
  readonly label: string;
  readonly options: readonly SegmentOption<V>[];
  readonly value: V;
  readonly onChange: (value: V) => void;
}

export function SegmentedFilter<V extends string = string>({
  label,
  options,
  value,
  onChange,
}: SegmentedFilterProps<V>) {
  return (
    <div role="group" aria-label={label} className="pw-segmented">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Button
            key={o.value}
            unstyled
            className={on ? 'pw-segmented__item pw-segmented__item--on' : 'pw-segmented__item'}
            aria-pressed={on}
            onClick={() => onChange(o.value)}
          >
            {o.label}
            {o.count !== undefined ? <span className="pw-segmented__count">{o.count}</span> : null}
          </Button>
        );
      })}
    </div>
  );
}

export interface FilterBarProps<V extends string = string> extends SegmentedFilterProps<V> {
  /** Extra controls after the segmented group (Select, search Input). */
  readonly children?: ReactNode;
  /** The result count on the right ("8 tenants"). */
  readonly resultCount?: ReactNode;
}

export function FilterBar<V extends string = string>({ children, resultCount, ...segmented }: FilterBarProps<V>) {
  return (
    <div className="pw-filterbar">
      <SegmentedFilter {...segmented} />
      {children}
      {resultCount !== undefined ? (
        <span className="pw-filterbar__count" role="status">
          {resultCount}
        </span>
      ) : null}
    </div>
  );
}
